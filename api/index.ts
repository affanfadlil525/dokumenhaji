import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || "";

// Use Service Role Key if available to bypass RLS in the backend
const supabase = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// API Routes

// Config check for debugging (masked)
app.get("/api/config-check", (req, res) => {
  res.json({
    hasUrl: !!process.env.SUPABASE_URL || !!process.env.VITE_SUPABASE_URL,
    hasAnonKey: !!process.env.SUPABASE_ANON_KEY || !!process.env.VITE_SUPABASE_ANON_KEY,
    hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY || !!process.env.VITE_SUPABASE_SERVICE_ROLE_KEY,
    env: process.env.NODE_ENV
  });
});
  
// Get all jamaah with optional search
app.get("/api/jamaah", async (req, res) => {
  const { q } = req.query;
  
  try {
    let query = supabase
      .from('jamaah')
      .select('*')
      .order('created_at', { ascending: false });

    if (q) {
      query = query.or(`nama.ilike.%${q}%,nomor_porsi.ilike.%${q}%,nomor.ilike.%${q}%`);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single jamaah
app.get("/api/jamaah/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('jamaah')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (data) {
      res.json(data);
    } else {
      res.status(404).json({ error: "Jamaah tidak ditemukan" });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create jamaah and document
app.post("/api/jamaah", async (req, res) => {
  const { nomor, nomor_porsi, nama, nama_ayah, alamat, phone, tanggal_daftar, foto, type, document_url } = req.body;
  
  try {
    // 1. Upsert Jamaah (based on nomor_porsi or nama+nama_ayah)
    // We use upsert so if the jamaah already exists, we just get their ID
    const { data: jamaahData, error: jamaahError } = await supabase
      .from('jamaah')
      .upsert({ 
        nomor_porsi, 
        nama, 
        nama_ayah, 
        alamat, 
        phone, 
        tanggal_daftar, 
        foto,
        updated_at: new Date().toISOString()
      }, { onConflict: 'nomor_porsi' })
      .select();

    if (jamaahError) throw jamaahError;
    const jamaahId = jamaahData[0].id;

    // 2. Save to Dokumen table
    const { data: docData, error: docError } = await supabase
      .from('dokumen')
      .insert([
        { 
          jamaah_id: jamaahId,
          type,
          nomor_dokumen: nomor,
          file_url: document_url,
          extracted_data: req.body // Store full extracted data for reference
        }
      ])
      .select();

    if (docError) {
      console.warn("Gagal menyimpan ke tabel dokumen, pastikan tabel 'dokumen' sudah dibuat:", docError.message);
      // We don't throw here to allow the jamaah save to succeed even if dokumen table is missing
    }
    
    res.status(201).json({ 
      id: jamaahId, 
      document_id: docData ? docData[0].id : null 
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update jamaah
app.put("/api/jamaah/:id", async (req, res) => {
  const { nomor, nomor_porsi, nama, nama_ayah, alamat, phone, tanggal_daftar, foto } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('jamaah')
      .update({ 
        nomor, 
        nomor_porsi, 
        nama, 
        nama_ayah, 
        alamat, 
        phone, 
        tanggal_daftar, 
        foto,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    
    if (data && data.length > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Jamaah tidak ditemukan" });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete jamaah
app.delete("/api/jamaah/:id", async (req, res) => {
  try {
    const { error, count } = await supabase
      .from('jamaah')
      .delete({ count: 'exact' })
      .eq('id', req.params.id);

    if (error) throw error;
    
    if (count && count > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Jamaah tidak ditemukan" });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reporting Endpoint: Get statistics
app.get("/api/reports/stats", async (req, res) => {
  try {
    // Total count
    const { count: totalCount, error: totalError } = await supabase
      .from('jamaah')
      .select('*', { count: 'exact', head: true });

    if (totalError) throw totalError;

    // Recent 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { count: recentCount, error: recentError } = await supabase
      .from('jamaah')
      .select('*', { count: 'exact', head: true })
      .gt('created_at', sevenDaysAgo.toISOString());

    if (recentError) throw recentError;
    
    res.json({
      total: totalCount || 0,
      recent_7_days: recentCount || 0
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

// Only listen if not in a serverless environment
const isServerless = process.env.VERCEL || process.env.NETLIFY;
if (!isServerless) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
