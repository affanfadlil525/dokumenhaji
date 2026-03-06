/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  Camera, 
  Upload, 
  FileText, 
  File,
  History, 
  UserPlus, 
  UserMinus, 
  UserCheck, 
  Save, 
  Trash2, 
  Loader2, 
  CheckCircle2,
  AlertCircle,
  Search,
  ChevronRight,
  MapPin,
  User,
  Hash,
  ArrowLeftRight,
  Calendar,
  BarChart3,
  Download,
  Printer,
  Lock,
  LogIn,
  LogOut,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI, Type } from "@google/genai";
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as XLSX from 'xlsx';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const cropImage = (imageUrl: string, box: number[]): Promise<string | null> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);

      // Gemini box format: [ymin, xmin, ymax, xmax] in 0-1000 scale
      const [ymin, xmin, ymax, xmax] = box;
      const x = (xmin / 1000) * img.width;
      const y = (ymin / 1000) * img.height;
      const width = ((xmax - xmin) / 1000) * img.width;
      const height = ((ymax - ymin) / 1000) * img.height;

      // Safety check for dimensions
      if (width <= 0 || height <= 0) return resolve(null);

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8)); // Use 0.8 quality to keep size reasonable
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
};

// --- Types ---
type DocType = 'pendaftaran' | 'pembatalan' | 'pelimpahan';

interface HajiRecord {
  id: string;
  type: DocType;
  nomor: string;
  nomorPorsi: string;
  nama: string;
  namaAyah: string;
  alamat: string;
  phone: string;
  tanggalDaftar: string;
  photoUrl: string;
  documentUrl: string;
  fullDocumentBase64?: string;
  isAutoCropped?: boolean;
  mimeType: string;
  timestamp: number;
}

// --- Constants ---
const GENAI_MODEL = "gemini-3-flash-preview";

// --- Components ---

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<'scan' | 'history' | 'recap' | 'database'>('scan');
  const [records, setRecords] = useState<HajiRecord[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<Partial<HajiRecord> | null>(null);
  const [selectedType, setSelectedType] = useState<DocType>('pendaftaran');
  const [searchQuery, setSearchQuery] = useState('');
  const [showManualCrop, setShowManualCrop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [backendConfig, setBackendConfig] = useState<{ hasServiceKey: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/config-check')
      .then(res => res.json())
      .then(data => setBackendConfig(data))
      .catch(() => setBackendConfig({ hasServiceKey: false }));
  }, []);

  const fetchRecords = useCallback(async (query: string = '') => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/jamaah?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error("Gagal mengambil data");
      const data = await response.json();
      
      // The API already returns data in camelCase and flattened structure
      // We just ensure ID is a string if needed
      const mappedData = data.map((item: any) => ({
        ...item,
        id: item.id.toString()
      }));
      
      setRecords(mappedData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords(searchQuery);
  }, [fetchRecords, searchQuery]);

  const saveRecord = async (record: Partial<HajiRecord>) => {
    try {
      const response = await fetch('/api/jamaah', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nomor: record.nomor,
          nomor_porsi: record.nomorPorsi,
          nama: record.nama,
          nama_ayah: record.namaAyah,
          alamat: record.alamat,
          phone: record.phone,
          tanggal_daftar: record.tanggalDaftar,
          foto: record.photoUrl,
          type: record.type,
          document_url: record.fullDocumentBase64 // Send the full document base64
        })
      });
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Gagal menyimpan data");
      }
      
      fetchRecords();
      setScanResult(null);
      setActiveTab('database');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deleteRecord = async (id: string) => {
    if (!confirm("Hapus data ini?")) return;
    try {
      const response = await fetch(`/api/jamaah/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error("Gagal menghapus data");
      fetchRecords();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleScan = async (file: File) => {
    setIsScanning(true);
    setScanResult(null);
    setError(null);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      setError("API Key tidak ditemukan. Jika Anda di Vercel, pastikan sudah menambahkan Environment Variable 'GEMINI_API_KEY'. Jika di AI Studio, pastikan Secrets sudah diatur.");
      setIsScanning(false);
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const reader = new FileReader();
      const base64DataPromise = new Promise<string>((resolve) => {
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
      });
      reader.readAsDataURL(file);
      const base64Data = await base64DataPromise;

      const response = await ai.models.generateContent({
        model: GENAI_MODEL,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: file.type,
                data: base64Data,
              },
            },
            {
              text: `Analisis dokumen haji ini (${selectedType}) dengan sangat teliti:
              1. Ekstrak data teks berikut dalam format JSON: nomor, nomorPorsi, nama, namaAyah, alamat, phone, tanggalDaftar (format YYYY-MM-DD).
              2. CARI PAS FOTO (foto wajah/setengah badan) jamaah yang biasanya tertempel atau tercetak di dokumen ini.
              3. Berikan koordinat kotak pembatas (bounding box) yang SANGAT AKURAT mengelilingi FOTO tersebut (bukan seluruh dokumen, tapi hanya area fotonya saja).
              4. Koordinat harus dalam format [ymin, xmin, ymax, xmax] dengan skala 0-1000. Gunakan key "face_box".
              5. Jika Anda melihat area foto yang jelas, berikan potongan foto tersebut sebagai BAGIAN GAMBAR (inlineData).
              
              PENTING: 
              - Pastikan koordinat "face_box" benar-benar hanya mencakup area foto jamaah.
              - Jika ada beberapa foto, pilih yang paling jelas (biasanya pas foto resmi).
              - Jika tidak ada foto wajah yang terdeteksi, jangan sertakan key "face_box".`,
            },
          ],
        },
        config: {
          systemInstruction: "Anda adalah ahli ekstraksi pas foto dari dokumen resmi. Fokus utama Anda adalah menemukan area foto wajah jamaah dan memberikan koordinatnya secara akurat.",
        }
      });

      let extractedData: any = {};
      let extractedPhotoUrl = "";
      const documentUrl = URL.createObjectURL(file);

      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          try {
            const jsonMatch = part.text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              extractedData = JSON.parse(jsonMatch[0]);
            }
          } catch (e) {
            console.error("JSON parse error", e);
          }
        }
        if (part.inlineData) {
          extractedPhotoUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
      }

      // If we have a face_box but no inlineData photo, perform client-side cropping
      if (!extractedPhotoUrl && extractedData.face_box && Array.isArray(extractedData.face_box)) {
        console.log("Attempting client-side crop with box:", extractedData.face_box);
        try {
          const cropped = await cropImage(documentUrl, extractedData.face_box);
          if (cropped) {
            extractedPhotoUrl = cropped;
          }
        } catch (cropErr) {
          console.error("Auto-crop failed:", cropErr);
        }
      }

      // Fallback: if still no photo, use the original document as a fallback so it's not empty
      // BUT make sure it's a base64, not a blob URL
      if (!extractedPhotoUrl) {
        console.warn("No photo extracted, using document as fallback");
        extractedPhotoUrl = `data:${file.type};base64,${base64Data}`; 
      }

      const result: Partial<HajiRecord> = {
        ...extractedData,
        photoUrl: extractedPhotoUrl,
        documentUrl: documentUrl,
        fullDocumentBase64: `data:${file.type};base64,${base64Data}`,
        mimeType: file.type,
        timestamp: Date.now(),
        type: selectedType,
        isAutoCropped: !!extractedPhotoUrl
      };

      setScanResult(result);
    } catch (err: any) {
      console.error("Scan error:", err);
      let errorMessage = err.message || "Terjadi kesalahan saat memproses dokumen.";
      let retryAfter = "";
      
      // Try to parse if it's a JSON string (often returned by Gemini SDK)
      try {
        if (typeof errorMessage === 'string' && errorMessage.trim().startsWith('{')) {
          const parsed = JSON.parse(errorMessage);
          if (parsed.error) {
            if (parsed.error.message) {
              errorMessage = parsed.error.message;
            }
            // Check for retry delay in details
            const retryInfo = parsed.error.details?.find((d: any) => d['@type']?.includes('RetryInfo'));
            if (retryInfo?.retryDelay) {
              retryAfter = retryInfo.retryDelay;
            }
          }
        }
      } catch (e) {
        // Not JSON, keep original
      }

      if (errorMessage.includes('429') || errorMessage.includes('Quota exceeded') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
        const waitMsg = retryAfter ? ` Silakan coba lagi dalam ${retryAfter}.` : " Mohon tunggu sekitar 1 menit sebelum mencoba lagi.";
        setError(`Batas penggunaan (Quota) API Gemini telah tercapai.${waitMsg} Ini adalah batasan dari layanan gratis Google Gemini.`);
      } else if (errorMessage.includes('API_KEY_INVALID')) {
        setError("API Key tidak valid. Periksa kembali konfigurasi GEMINI_API_KEY Anda.");
      } else {
        setError(errorMessage);
      }
    } finally {
      setIsScanning(false);
    }
  };

  if (!isLoggedIn) {
    return <LoginView onLogin={() => setIsLoggedIn(true)} />;
  }

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans flex flex-col md:flex-row">
      {/* Sidebar - Hidden on Mobile */}
      <aside className="hidden md:flex w-64 bg-white border-r border-black/5 flex-col sticky top-0 h-screen">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white">
              <FileText size={24} />
            </div>
            <div>
              <h1 className="font-bold text-sm leading-tight">HAJI DIGITAL</h1>
              <p className="text-[10px] text-black/40 uppercase tracking-wider">Kutai Barat</p>
            </div>
          </div>

          <nav className="space-y-1">
            <button 
              onClick={() => setActiveTab('scan')}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
                activeTab === 'scan' ? "bg-emerald-50 text-emerald-700 shadow-sm" : "text-black/60 hover:bg-black/5"
              )}
            >
              <Camera size={18} />
              Scan Dokumen
            </button>
            <button 
              onClick={() => setActiveTab('database')}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
                activeTab === 'database' ? "bg-emerald-50 text-emerald-700 shadow-sm" : "text-black/60 hover:bg-black/5"
              )}
            >
              <History size={18} />
              Database Jamaah
            </button>
            <button 
              onClick={() => setActiveTab('recap')}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
                activeTab === 'recap' ? "bg-emerald-50 text-emerald-700 shadow-sm" : "text-black/60 hover:bg-black/5"
              )}
            >
              <BarChart3 size={18} />
              Rekap Tahunan
            </button>
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-black/5 space-y-4">
          <div className="bg-emerald-900/5 rounded-2xl p-4">
            <p className="text-[11px] font-semibold text-emerald-800 uppercase mb-1">Status Kantor</p>
            <p className="text-xs text-emerald-700/70">kemenhaj Kutai Barat Aktif</p>
          </div>
          
          <button 
            onClick={() => setIsLoggedIn(false)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-rose-600 hover:bg-rose-50 transition-all"
          >
            <LogOut size={18} />
            Keluar Sistem
          </button>
        </div>
      </aside>

      {/* Mobile Top Header */}
      <div className="md:hidden bg-white border-b border-black/5 p-4 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white">
            <FileText size={18} />
          </div>
          <h1 className="font-bold text-xs">HAJI DIGITAL</h1>
        </div>
        <button 
          onClick={() => setIsLoggedIn(false)}
          className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg"
        >
          <LogOut size={18} />
        </button>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 pb-24 md:pb-8">
        {backendConfig && !backendConfig.hasServiceKey && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3 text-amber-700 max-w-4xl mx-auto">
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm">Peringatan: Database Belum Terkonfigurasi Penuh</p>
              <p className="text-xs opacity-90">
                Environment variable <b>SUPABASE_SERVICE_ROLE_KEY</b> belum ditemukan di backend. 
                Hal ini mungkin menyebabkan error "Row-Level Security" saat menyimpan data. 
                Silakan tambahkan key tersebut di menu Secrets/Environment Variables.
              </p>
            </div>
          </div>
        )}
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-3 text-red-700 max-w-4xl mx-auto"
          >
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">Terjadi Kesalahan</p>
              <p className="text-sm opacity-90">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-full">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}

        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <h2 className="text-xl md:text-2xl font-bold tracking-tight">
            {activeTab === 'scan' ? 'Pemindaian Dokumen Baru' : 
             activeTab === 'database' ? 'Database Jamaah Haji' : 'Rekapitulasi Tahunan'}
          </h2>
          
          {activeTab === 'database' && (
            <div className="relative w-full md:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-black/30" size={16} />
              <input 
                type="text" 
                placeholder="Cari nama atau nomor porsi..."
                className="w-full bg-white md:bg-[#F5F5F5] border border-black/5 md:border-none rounded-full py-2.5 pl-10 pr-4 text-sm focus:ring-2 focus:ring-emerald-500/20 transition-all shadow-sm md:shadow-none"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          )}
        </header>

        <div className="max-w-5xl mx-auto">
          <AnimatePresence mode="wait">
            {activeTab === 'scan' ? (
              <motion.div 
                key="scan-view"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-8"
              >
                {/* Type Selector */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {[
                    { id: 'pendaftaran', label: 'Pendaftaran', icon: UserPlus, color: 'emerald' },
                    { id: 'pembatalan', label: 'Pembatalan', icon: UserMinus, color: 'rose' },
                    { id: 'pelimpahan', label: 'Pelimpahan', icon: ArrowLeftRight, color: 'amber' }
                  ].map((type) => (
                    <button
                      key={type.id}
                      onClick={() => setSelectedType(type.id as DocType)}
                      className={cn(
                        "flex flex-col items-center gap-3 p-6 rounded-2xl border-2 transition-all",
                        selectedType === type.id 
                          ? `bg-${type.color}-50 border-${type.color}-500 text-${type.color}-700 shadow-md scale-[1.02]` 
                          : "bg-white border-transparent text-black/40 hover:border-black/10"
                      )}
                    >
                      <type.icon size={32} />
                      <span className="font-semibold text-sm">{type.label}</span>
                    </button>
                  ))}
                </div>

                {/* Dropzone */}
                {!scanResult && !isScanning && (
                  <Dropzone onFile={handleScan} />
                )}

                {/* Scanning State */}
                {isScanning && (
                  <div className="bg-white rounded-3xl p-8 md:p-12 flex flex-col items-center justify-center border-2 border-dashed border-emerald-200 shadow-xl shadow-emerald-500/5">
                    <div className="relative mb-6">
                      <div className="w-16 h-16 md:w-20 md:h-20 border-4 border-emerald-100 border-t-emerald-600 rounded-full animate-spin" />
                      <Camera className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-emerald-600" size={24} />
                    </div>
                    <h3 className="text-lg md:text-xl font-bold mb-2">Menganalisis Dokumen...</h3>
                    <p className="text-black/40 text-xs md:text-sm text-center">AI sedang mengekstrak data dari foto Anda</p>
                  </div>
                )}

                {/* Result Preview */}
                {scanResult && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="grid grid-cols-1 md:grid-cols-2 gap-8"
                  >
                    <div className="bg-white rounded-3xl overflow-hidden shadow-xl border border-black/5">
                      <div className="p-4 bg-black/5 flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-widest opacity-40">Foto Calon Jamaah</span>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => setShowManualCrop(true)}
                            className="text-[10px] font-bold text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded-md transition-colors"
                          >
                            Potong Manual
                          </button>
                          <button onClick={() => setScanResult(null)} className="text-xs font-medium text-rose-600 hover:underline">Batal</button>
                        </div>
                      </div>
                      <div className="w-full h-[300px] md:h-[400px] bg-zinc-100 flex items-center justify-center p-4">
                        <img 
                          src={scanResult.photoUrl} 
                          alt="Foto Jamaah" 
                          className="max-w-full max-h-full object-contain rounded-2xl shadow-lg border-4 border-white" 
                          referrerPolicy="no-referrer" 
                          onError={(e) => {
                            // If the cropped image fails, show the full document as fallback
                            if (scanResult.photoUrl !== scanResult.documentUrl) {
                              (e.target as HTMLImageElement).src = scanResult.documentUrl || '';
                            }
                          }}
                        />
                      </div>
                      <div className="p-4 border-t border-black/5 bg-zinc-50 flex items-center justify-between">
                        <p className="text-[10px] text-black/40 uppercase font-bold tracking-tighter">Hasil Pemotongan AI</p>
                        <a 
                          href={scanResult.documentUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-[10px] font-bold text-emerald-600 hover:underline flex items-center gap-1"
                        >
                          Lihat Dokumen Asli <ChevronRight size={10} />
                        </a>
                      </div>
                    </div>

                    <div className="bg-white rounded-3xl p-8 shadow-xl border border-black/5 space-y-6">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-lg font-bold">Data Hasil Scan</h3>
                        <span className={cn(
                          "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                          selectedType === 'pendaftaran' ? "bg-emerald-100 text-emerald-700" :
                          selectedType === 'pembatalan' ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
                        )}>
                          {selectedType}
                        </span>
                      </div>

                      <div className="space-y-4">
                        <DataField icon={Hash} label="Nomor Dokumen" value={scanResult.nomor} onChange={(v) => setScanResult({...scanResult, nomor: v})} />
                        <DataField icon={Hash} label="Nomor Porsi" value={scanResult.nomorPorsi} onChange={(v) => setScanResult({...scanResult, nomorPorsi: v})} />
                        <DataField icon={User} label="Nama Jamaah" value={scanResult.nama} onChange={(v) => setScanResult({...scanResult, nama: v})} />
                        <DataField icon={User} label="Nama Ayah" value={scanResult.namaAyah} onChange={(v) => setScanResult({...scanResult, namaAyah: v})} />
                        <DataField icon={Hash} label="Nomor HP Jamaah" value={scanResult.phone} onChange={(v) => setScanResult({...scanResult, phone: v})} />
                        <DataField icon={Calendar} label="Tanggal Pendaftaran" value={scanResult.tanggalDaftar} onChange={(v) => setScanResult({...scanResult, tanggalDaftar: v})} />
                        <DataField icon={MapPin} label="Alamat" value={scanResult.alamat} onChange={(v) => setScanResult({...scanResult, alamat: v})} isArea />
                      </div>

                      <button 
                        onClick={() => saveRecord(scanResult)}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-600/20"
                      >
                        <Save size={20} />
                        Simpan ke Database
                      </button>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            ) : activeTab === 'database' ? (
              <motion.div 
                key="database-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-6"
              >
                {isLoading ? (
                  <div className="flex justify-center p-20">
                    <Loader2 className="animate-spin text-emerald-600" size={40} />
                  </div>
                ) : records.length === 0 ? (
                  <div className="bg-white rounded-3xl p-20 flex flex-col items-center justify-center border border-black/5 text-center">
                    <div className="w-20 h-20 bg-black/5 rounded-full flex items-center justify-center mb-6">
                      <History size={40} className="text-black/20" />
                    </div>
                    <h3 className="text-xl font-bold mb-2">Belum ada data</h3>
                    <p className="text-black/40 text-sm max-w-xs">Data yang Anda scan akan muncul di sini untuk dikelola.</p>
                    <button 
                      onClick={() => setActiveTab('scan')}
                      className="mt-8 text-emerald-600 font-bold flex items-center gap-2 hover:underline"
                    >
                      Mulai scan sekarang <ChevronRight size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {records.map((record) => (
                      <RecordCard key={record.id} record={record} onDelete={deleteRecord} />
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div 
                key="recap-view"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <RecapView records={records} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Mobile Bottom Navigation */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-black/5 px-6 py-3 flex items-center justify-between z-20 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
          <button 
            onClick={() => setActiveTab('scan')}
            className={cn(
              "flex flex-col items-center gap-1 transition-all",
              activeTab === 'scan' ? "text-emerald-600" : "text-black/30"
            )}
          >
            <Camera size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Scan</span>
          </button>
          <button 
            onClick={() => setActiveTab('database')}
            className={cn(
              "flex flex-col items-center gap-1 transition-all",
              activeTab === 'database' ? "text-emerald-600" : "text-black/30"
            )}
          >
            <History size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Data</span>
          </button>
          <button 
            onClick={() => setActiveTab('recap')}
            className={cn(
              "flex flex-col items-center gap-1 transition-all",
              activeTab === 'recap' ? "text-emerald-600" : "text-black/30"
            )}
          >
            <BarChart3 size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Rekap</span>
          </button>
        </nav>

        {/* Manual Crop Modal */}
        <AnimatePresence>
          {showManualCrop && scanResult && (
            <ManualCropModal 
              imageUrl={scanResult.documentUrl || ''} 
              onCrop={(croppedUrl) => {
                setScanResult({ ...scanResult, photoUrl: croppedUrl, isAutoCropped: false });
                setShowManualCrop(false);
              }}
              onClose={() => setShowManualCrop(false)}
            />
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Subcomponents ---

function ManualCropModal({ imageUrl, onCrop, onClose }: { imageUrl: string, onCrop: (url: string) => void, onClose: () => void }) {
  const [box, setBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });
    setBox({ x, y, w: 0, h: 0 });
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !box || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const currentY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    
    setBox({
      x: Math.min(startPos.x, currentX),
      y: Math.min(startPos.y, currentY),
      w: Math.abs(currentX - startPos.x),
      h: Math.abs(currentY - startPos.y)
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const applyCrop = async () => {
    if (!box || !imgRef.current) return;
    const img = imgRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scaleX = img.naturalWidth / img.width;
    const scaleY = img.naturalHeight / img.height;

    canvas.width = box.w * scaleX;
    canvas.height = box.h * scaleY;

    ctx.drawImage(
      img,
      box.x * scaleX, box.y * scaleY, box.w * scaleX, box.h * scaleY,
      0, 0, canvas.width, canvas.height
    );

    onCrop(canvas.toDataURL('image/jpeg'));
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div className="bg-white rounded-3xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 border-b border-black/5 flex items-center justify-between bg-zinc-50">
          <div>
            <h3 className="font-bold text-lg">Potong Foto Manual</h3>
            <p className="text-xs text-black/40">Seret mouse pada area wajah jamaah untuk memotong</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-full transition-colors">
            <Trash2 size={20} className="text-black/40" />
          </button>
        </div>

        <div 
          ref={containerRef}
          className="flex-1 overflow-auto p-8 bg-zinc-200 flex items-center justify-center relative select-none"
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <div className="relative inline-block">
            <img 
              ref={imgRef}
              src={imageUrl} 
              alt="To crop" 
              className="max-w-full max-h-[60vh] shadow-2xl cursor-crosshair"
              onMouseDown={handleMouseDown}
              draggable={false}
            />
            {box && (
              <div 
                className="absolute border-2 border-emerald-500 bg-emerald-500/20 pointer-events-none"
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.w,
                  height: box.h
                }}
              >
                <div className="absolute -top-6 left-0 bg-emerald-600 text-white text-[10px] px-2 py-0.5 rounded font-bold">
                  Area Foto
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-6 border-t border-black/5 flex items-center justify-end gap-4 bg-zinc-50">
          <button 
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl text-sm font-bold text-black/40 hover:bg-black/5 transition-all"
          >
            Batal
          </button>
          <button 
            onClick={applyCrop}
            disabled={!box || box.w < 10}
            className="px-8 py-2.5 rounded-xl text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-600/20 disabled:opacity-50 disabled:shadow-none"
          >
            Terapkan Potongan
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function LoginView({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    // Simple hardcoded credentials for demo
    if (username === 'admin' && password === 'kemenhajkubar') {
      onLogin();
    } else {
      setError('Username atau Password salah!');
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F5] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-white rounded-[32px] shadow-2xl border border-black/5 overflow-hidden"
      >
        <div className="p-10">
          <div className="flex flex-col items-center text-center mb-10">
            <div className="w-20 h-20 bg-emerald-600 rounded-3xl flex items-center justify-center text-white mb-6 shadow-xl shadow-emerald-600/20">
              <Lock size={40} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight mb-2">Akses Administrator</h1>
            <p className="text-black/40 text-sm">Sistem Digitalisasi Dokumen Haji<br/>kemenhaj Kabupaten Kutai Barat</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-black/40 ml-1">Username</label>
              <div className="relative">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 text-black/20" size={18} />
                <input 
                  type="text" 
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-[#F9F9F9] border border-black/5 rounded-2xl py-4 pl-12 pr-4 text-sm focus:ring-2 focus:ring-emerald-500/10 outline-none transition-all"
                  placeholder="Masukkan username"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-black/40 ml-1">Password</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-black/20" size={18} />
                <input 
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#F9F9F9] border border-black/5 rounded-2xl py-4 pl-12 pr-4 text-sm focus:ring-2 focus:ring-emerald-500/10 outline-none transition-all"
                  placeholder="Masukkan password"
                  required
                />
              </div>
            </div>

            {error && (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-rose-50 text-rose-600 text-xs font-bold p-4 rounded-xl flex items-center gap-2"
              >
                <AlertCircle size={14} />
                {error}
              </motion.div>
            )}

            <button 
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-600/20 active:scale-[0.98]"
            >
              <LogIn size={20} />
              Masuk ke Sistem
            </button>
          </form>
        </div>
        
        <div className="bg-zinc-50 p-6 text-center border-t border-black/5">
          <p className="text-[10px] text-black/30 font-bold uppercase tracking-widest">Keamanan Terjamin • kemenhaj RI</p>
        </div>
      </motion.div>
    </div>
  );
}

function RecapView({ records }: { records: HajiRecord[] }) {
  const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString());
  
  const handlePrint = () => {
    window.print();
  };

  const handleExportExcel = () => {
    const filteredByYear = records.filter(r => r.tanggalDaftar.startsWith(selectedYear));
    
    if (filteredByYear.length === 0) {
      alert("Tidak ada data untuk diekspor pada tahun ini.");
      return;
    }

    const exportData = filteredByYear.map(r => ({
      'Tanggal Daftar': new Date(r.tanggalDaftar).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }),
      'Nama Jamaah': r.nama,
      'Nama Ayah': r.namaAyah,
      'Nomor Porsi': r.nomorPorsi,
      'Tipe Dokumen': r.type.toUpperCase(),
      'Nomor HP': r.phone || '-',
      'Alamat': r.alamat
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `Rekap Haji ${selectedYear}`);
    
    // Auto-size columns
    const maxWidths = Object.keys(exportData[0]).map(key => 
      Math.max(...exportData.map(row => String((row as any)[key]).length), key.length) + 2
    );
    worksheet['!cols'] = maxWidths.map(w => ({ wch: w }));

    XLSX.writeFile(workbook, `Rekap_Haji_Kubar_${selectedYear}.xlsx`);
  };

  const years = Array.from(new Set(records.map(r => r.tanggalDaftar.split('-')[0]))).sort((a, b) => b.localeCompare(a));
  
  const filteredByYear = records.filter(r => r.tanggalDaftar.startsWith(selectedYear));
  
  const stats = {
    total: filteredByYear.length,
    pendaftaran: filteredByYear.filter(r => r.type === 'pendaftaran').length,
    pembatalan: filteredByYear.filter(r => r.type === 'pembatalan').length,
    pelimpahan: filteredByYear.filter(r => r.type === 'pelimpahan').length,
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <label className="text-sm font-bold text-black/40 uppercase tracking-wider">Pilih Tahun:</label>
          <select 
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            className="bg-white border border-black/5 rounded-xl px-4 py-2 text-sm font-bold focus:ring-2 focus:ring-emerald-500/10 outline-none"
          >
            {years.length > 0 ? years.map(y => (
              <option key={y} value={y}>{y}</option>
            )) : <option value={new Date().getFullYear()}>{new Date().getFullYear()}</option>}
          </select>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={handlePrint}
            className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-emerald-600 text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-600/20"
          >
            <Printer size={18} />
            Cetak
          </button>
          <button 
            onClick={handleExportExcel}
            className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-black text-white px-6 py-2.5 rounded-xl text-sm font-bold hover:bg-black/80 transition-all"
          >
            <Download size={18} />
            Ekspor
          </button>
        </div>
      </div>

      <div className="print-only mb-8 text-center border-b-2 border-black pb-6">
        <h1 className="text-2xl font-bold uppercase">REKAPITULASI DATA JAMAAH HAJI TAHUN {selectedYear}</h1>
        <p className="text-sm">Kantor Kementerian Agama Kabupaten Kutai Barat</p>
        <p className="text-xs mt-1 italic">Dicetak pada: {new Date().toLocaleString('id-ID')}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
        <StatCard label="Total" value={stats.total} color="black" />
        <StatCard label="Daftar" value={stats.pendaftaran} color="emerald" />
        <StatCard label="Batal" value={stats.pembatalan} color="rose" />
        <StatCard label="Limpah" value={stats.pelimpahan} color="amber" />
      </div>

      <div className="bg-white rounded-3xl border border-black/5 overflow-hidden shadow-sm">
        <div className="p-6 border-b border-black/5 bg-zinc-50/50">
          <h3 className="font-bold text-sm uppercase tracking-wider text-black/40">Daftar Rekapitulasi {selectedYear}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-black/5 text-[10px] font-bold uppercase tracking-widest text-black/30">
                <th className="px-6 py-4">Tgl Daftar</th>
                <th className="px-6 py-4">Nama Jamaah</th>
                <th className="px-6 py-4">Nama Ayah</th>
                <th className="px-6 py-4">Nomor Porsi</th>
                <th className="px-6 py-4">Tipe</th>
                <th className="px-6 py-4">Kontak</th>
                <th className="px-6 py-4">Alamat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {filteredByYear.length > 0 ? filteredByYear.map(record => (
                <tr key={record.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-6 py-4 text-xs font-medium whitespace-nowrap">{new Date(record.tanggalDaftar).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <img src={record.photoUrl} className="w-8 h-8 rounded-full object-cover border border-black/5 no-print" />
                      <span className="text-sm font-bold">{record.nama}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-xs">{record.namaAyah}</td>
                  <td className="px-6 py-4 text-xs font-mono font-bold text-emerald-700">{record.nomorPorsi}</td>
                  <td className="px-6 py-4">
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider",
                      record.type === 'pendaftaran' ? "bg-emerald-100 text-emerald-700" :
                      record.type === 'pembatalan' ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
                    )}>
                      {record.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-xs text-black/50">{record.phone || '-'}</td>
                  <td className="px-6 py-4 text-[10px] text-black/40 max-w-[200px] truncate">{record.alamat}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-black/30 text-sm italic">Tidak ada data untuk tahun ini</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string, value: number, color: string }) {
  const colors: any = {
    black: "bg-black text-white",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
    rose: "bg-rose-50 text-rose-700 border-rose-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
  };

  return (
    <div className={cn("p-6 rounded-3xl border transition-all hover:scale-[1.02]", colors[color] || "bg-white")}>
      <p className={cn("text-[10px] font-bold uppercase tracking-widest mb-1 opacity-60")}>{label}</p>
      <p className="text-3xl font-bold tracking-tight">{value}</p>
    </div>
  );
}

function Dropzone({ onFile }: { onFile: (file: File) => void }) {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      onFile(acceptedFiles[0]);
    }
  }, [onFile]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: { 
      'image/*': [],
      'application/pdf': []
    },
    multiple: false
  });

  return (
    <div 
      {...getRootProps()} 
      className={cn(
        "bg-white rounded-3xl p-16 flex flex-col items-center justify-center border-2 border-dashed transition-all cursor-pointer group",
        isDragActive ? "border-emerald-500 bg-emerald-50" : "border-black/10 hover:border-emerald-400 hover:bg-emerald-50/30"
      )}
    >
      <input {...getInputProps()} />
      <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
        <Upload className="text-emerald-600" size={40} />
      </div>
      <h3 className="text-2xl font-bold mb-3">Klik atau seret file dokumen</h3>
      <p className="text-black/40 text-base max-w-md text-center">
        Ambil foto atau unggah PDF surat pendaftaran, pembatalan, atau pelimpahan jamaah haji dengan jelas.
      </p>
      <div className="mt-10 flex items-center gap-6 text-xs font-bold uppercase tracking-widest text-black/30">
        <span className="flex items-center gap-2"><CheckCircle2 size={14} className="text-emerald-500" /> Kualitas HD</span>
        <span className="flex items-center gap-2"><CheckCircle2 size={14} className="text-emerald-500" /> Ekstraksi AI</span>
        <span className="flex items-center gap-2"><CheckCircle2 size={14} className="text-emerald-500" /> Aman</span>
      </div>
    </div>
  );
}

function DataField({ icon: Icon, label, value, onChange, isArea }: { 
  icon: any, 
  label: string, 
  value?: string, 
  onChange: (v: string) => void,
  isArea?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] font-bold uppercase tracking-wider text-black/40 flex items-center gap-1.5 ml-1">
        <Icon size={12} />
        {label}
      </label>
      {isArea ? (
        <textarea 
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[#F9F9F9] border border-black/5 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-500/30 transition-all min-h-[80px] resize-none"
        />
      ) : (
        <input 
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[#F9F9F9] border border-black/5 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500/10 focus:border-emerald-500/30 transition-all"
        />
      )}
    </div>
  );
}

function RecordCard({ record, onDelete }: { record: HajiRecord, onDelete: (id: string) => void }) {
  const formatDate = (dateStr: string) => {
    try {
      if (!dateStr || dateStr === "TIDAK TERDETEKSI") return "-";
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return "-";
      return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) {
      return "-";
    }
  };

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      className="bg-white rounded-2xl p-4 md:p-6 border border-black/5 shadow-sm hover:shadow-md transition-all flex flex-col sm:flex-row gap-4 md:gap-6 group"
    >
      <div className="w-full sm:w-24 h-48 sm:h-24 rounded-xl overflow-hidden bg-zinc-100 flex-shrink-0 border border-black/5 flex items-center justify-center relative">
        {record.photoUrl && (record.photoUrl.startsWith('data:image') || record.photoUrl.startsWith('blob:')) ? (
          <img 
            src={record.photoUrl} 
            alt="Foto Jamaah" 
            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" 
            referrerPolicy="no-referrer" 
            onError={(e) => {
              (e.target as HTMLImageElement).src = "https://picsum.photos/seed/error/200/300";
            }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-black/20">
            <User size={32} />
            <span className="text-[8px] font-bold uppercase mt-1">No Photo</span>
          </div>
        )}
        <a 
          href={record.documentUrl} 
          target="_blank" 
          rel="noopener noreferrer"
          className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-[10px] font-bold uppercase"
        >
          Lihat Dokumen
        </a>
      </div>
      
      <div className="flex-1 grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 items-center">
        <div>
          <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mb-0.5 md:mb-1">Jamaah</p>
          <p className="font-bold text-sm truncate">{record.nama || "TIDAK TERDETEKSI"}</p>
          <p className="text-xs text-black/40 italic">bin {record.namaAyah || "-"}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mb-0.5 md:mb-1">Nomor Porsi</p>
          <p className="font-mono text-sm font-semibold text-emerald-700">{record.nomorPorsi || "TIDAK TERDETEKSI"}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mb-0.5 md:mb-1">Tipe Dokumen</p>
          <span className={cn(
            "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider inline-block",
            record.type === 'pendaftaran' ? "bg-emerald-100 text-emerald-700" :
            record.type === 'pembatalan' ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
          )}>
            {record.type}
          </span>
        </div>
        <div className="hidden sm:block">
          <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mb-0.5 md:mb-1">Tgl Daftar</p>
          <p className="text-xs font-medium">{formatDate(record.tanggalDaftar)}</p>
        </div>
        <div className="flex items-center justify-end gap-3 col-span-2 lg:col-span-1">
          <div className="text-right mr-4 hidden lg:block">
            <p className="text-[10px] font-bold text-black/30 uppercase tracking-widest mb-0.5 md:mb-1">Tanggal Scan</p>
            <p className="text-xs text-black/50">{new Date(record.timestamp).toLocaleDateString('id-ID')}</p>
          </div>
          <button 
            onClick={() => onDelete(record.id)}
            className="p-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors md:opacity-0 md:group-hover:opacity-100"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
