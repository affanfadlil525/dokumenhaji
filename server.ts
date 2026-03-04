import express from "express";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API Routes
  
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

  // Create jamaah
  app.post("/api/jamaah", async (req, res) => {
    const { nomor, nomor_porsi, nama, nama_ayah, alamat, phone, tanggal_daftar, foto } = req.body;
    
    try {
      const { data, error } = await supabase
        .from('jamaah')
        .insert([
          { nomor, nomor_porsi, nama, nama_ayah, alamat, phone, tanggal_daftar, foto }
        ])
        .select();

      if (error) {
        if (error.code === '23505') { // Unique constraint violation in Postgres
          return res.status(400).json({ error: "Nomor porsi sudah terdaftar" });
        }
        throw error;
      }
      
      res.status(201).json({ id: data[0].id });
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
