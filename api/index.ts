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
  
// Get all records (jamaah + latest document)
app.get("/api/jamaah", async (req, res) => {
  const { query: q } = req.query; // Support both 'query' and 'q'
  const searchQuery = q || req.query.q;
  
  try {
    // We want to get documents joined with their jamaah
    let query = supabase
      .from('dokumen')
      .select(`
        id,
        type,
        nomor_dokumen,
        file_url,
        created_at,
        jamaah:jamaah_id (
          id,
          nomor_porsi,
          nama,
          nama_ayah,
          alamat,
          phone,
          tanggal_daftar,
          foto
        )
      `)
      .order('created_at', { ascending: false });

    if (searchQuery) {
      // Search in jamaah name or nomor_porsi or nomor_dokumen
      // Note: complex cross-table search in Supabase JS client can be tricky
      // For now, we'll search in the dokumen's nomor_dokumen or use a raw filter if needed
      query = query.or(`nomor_dokumen.ilike.%${searchQuery}%`);
      // If we need to search in jamaah fields, we might need a different approach or a view
    }

    const { data, error } = await query;

    if (error) throw error;

    // Map to camelCase and flatten for the frontend HajiRecord interface
    const mappedData = data.map((doc: any) => {
      // Handle potential array from join
      const jamaah = Array.isArray(doc.jamaah) ? doc.jamaah[0] : doc.jamaah;
      
      return {
        id: doc.id,
        type: doc.type,
        nomor: doc.nomor_dokumen,
        nomorPorsi: jamaah?.nomor_porsi || "TIDAK TERDETEKSI",
        nama: jamaah?.nama || "TIDAK TERDETEKSI",
        namaAyah: jamaah?.nama_ayah || "TIDAK TERDETEKSI",
        alamat: jamaah?.alamat || "",
        phone: jamaah?.phone || "",
        tanggalDaftar: jamaah?.tanggal_daftar || new Date().toISOString(),
        photoUrl: jamaah?.foto || "",
        documentUrl: doc.file_url,
        timestamp: new Date(doc.created_at).getTime()
      };
    });

    res.json(mappedData);
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
    let jamaahId;

    // 1. Find or Create Jamaah
    if (nomor_porsi && nomor_porsi !== "TIDAK TERDETEKSI") {
      // Check if jamaah exists
      const { data: existingJamaah, error: findError } = await supabase
        .from('jamaah')
        .select('id')
        .eq('nomor_porsi', nomor_porsi)
        .maybeSingle();

      if (findError) console.error("Find error:", findError);

      if (existingJamaah) {
        // Update existing
        const { data: updateData, error: updateError } = await supabase
          .from('jamaah')
          .update({ 
            nama, 
            nama_ayah, 
            alamat, 
            phone, 
            tanggal_daftar, 
            foto,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingJamaah.id)
          .select();
        
        if (updateError) throw updateError;
        jamaahId = updateData[0].id;
      } else {
        // Insert new
        const { data: insertData, error: insertError } = await supabase
          .from('jamaah')
          .insert([{ 
            nomor_porsi, 
            nama, 
            nama_ayah, 
            alamat, 
            phone, 
            tanggal_daftar, 
            foto 
          }])
          .select();
        
        if (insertError) throw insertError;
        jamaahId = insertData[0].id;
      }
    }

    // If no jamaahId yet (either nomor_porsi was invalid or not found)
    if (!jamaahId) {
      const { data: jamaahData, error: jamaahError } = await supabase
        .from('jamaah')
        .insert([
          { 
            nomor_porsi: (nomor_porsi && nomor_porsi !== "TIDAK TERDETEKSI") ? nomor_porsi : `TEMP-${Date.now()}`, 
            nama, 
            nama_ayah, 
            alamat, 
            phone, 
            tanggal_daftar, 
            foto 
          }
        ])
        .select();

      if (jamaahError) throw jamaahError;
      jamaahId = jamaahData[0].id;
    }

    // 2. Save to Dokumen table
    const { data: docData, error: docError } = await supabase
      .from('dokumen')
      .insert([
        { 
          jamaah_id: jamaahId,
          type,
          nomor_dokumen: nomor,
          file_url: document_url,
          extracted_data: req.body 
        }
      ])
      .select();

    if (docError) throw docError;
    
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

// Delete record (document)
app.delete("/api/jamaah/:id", async (req, res) => {
  try {
    const { error, count } = await supabase
      .from('dokumen')
      .delete({ count: 'exact' })
      .eq('id', req.params.id);

    if (error) throw error;
    
    if (count && count > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Record tidak ditemukan" });
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
