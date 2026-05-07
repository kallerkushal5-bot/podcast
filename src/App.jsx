import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore, collection, addDoc, getDocs,
  deleteDoc, doc, query, orderBy, setDoc
} from "firebase/firestore";

/* ═══════════════════════════════════════════════════════════════
   DUAL STORAGE SYSTEM
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CLOUD  → Cloudinary (files) + Firebase Firestore (metadata)
            All episodes visible to every visitor — shared cloud DB.

   LOCAL  → IndexedDB (blobs)  +  localStorage (metadata cache)
            Kept as offline fallback / instant load while Firestore fetches.
   ═══════════════════════════════════════════════════════════════ */

/* ── Firebase config — REPLACE these values with yours ──────── */
/* Get them from: Firebase Console → Project Settings → Your Apps */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAoPtqcQX4g1wsmvPa1ElkZ9XS3OCGvkHU",
  authDomain:        "my-podcast-38f22.firebaseapp.com",
  projectId:         "my-podcast-38f22",
  storageBucket:     "my-podcast-38f22.firebasestorage.app",
  messagingSenderId: "1054925017167",
  appId:             "1:1054925017167:web:8bb8c96aa0b550d50d5a3a",
};

/* ── Firebase init (safe for hot-reload / Strict Mode) ──────── */
const firebaseApp = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
const db = getFirestore(firebaseApp);

const API_BASE         = typeof window !== "undefined" ? window.location.origin : "";
const CATEGORY_FOLDER  = { audio:"audios", video:"videos", song:"songs", image:"images" };
const FALLBACK_IMG     = "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=500&q=80";
const META_KEY         = "sn_uploadedEps";
const DB_NAME          = "signalNoisePodcast";
const DB_VER           = 2;
const STORE            = "episodeFiles";
const THUMB_STORE      = "episodeThumbs";

/* ── Cloudinary config ───────────────────────────────────────── */
const CLOUDINARY_CLOUD = "dz7nfmey1";
const CLOUDINARY_PRESET = "podcast_upload"; // unsigned upload preset name
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`;

/* ── helpers ─────────────────────────────────────────────────── */
function publicMediaUrl(category, fileName) {
  if (!fileName) return null;
  return `${API_BASE}/${CATEGORY_FOLDER[category] || "audios"}/${encodeURIComponent(fileName)}`;
}
function safeFileName(name) {
  const ext  = name.split(".").pop().toLowerCase();
  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `${Date.now()}_${base}.${ext}`;
}

/* ── Firebase is always available — no ping needed ───────────── */
async function checkServerOnline() { return true; }

/* ── Cloudinary upload (XHR for progress) ────────────────────── */
async function cloudUploadFile(file, category, onProgress) {
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("upload_preset", CLOUDINARY_PRESET);
    // Tag by category so files are organized in Cloudinary
    fd.append("tags", `podcast,${category}`);
    // Use a folder per category
    fd.append("folder", `podcast/${CATEGORY_FOLDER[category] || "audios"}`);

    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", CLOUDINARY_UPLOAD_URL);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && onProgress)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const res = JSON.parse(xhr.responseText);
            // Normalize to the shape the rest of the app expects
            resolve({ publicUrl: res.secure_url, fileName: res.public_id, cloudinaryId: res.public_id });
          } catch { reject(new Error("Invalid Cloudinary response")); }
        } else {
          try { reject(new Error(JSON.parse(xhr.responseText).error?.message || `HTTP ${xhr.status}`)); }
          catch { reject(new Error(`HTTP ${xhr.status}`)); }
        }
      };
      xhr.onerror   = () => reject(new Error("Network error"));
      xhr.ontimeout = () => reject(new Error("Upload timed out"));
      xhr.timeout   = 300_000; // 5 min for large video files
      xhr.send(fd);
    });
  } catch (e) { console.warn("[cloudinary] upload failed:", e.message); return null; }
}

/* ── Episode metadata: Firestore (shared across all visitors) ─── */

/**
 * Save one episode's metadata to Firestore.
 * We use the episode's own `id` as the Firestore document ID so
 * deletes and dedup work correctly.
 */
async function cloudSaveEpisodeMeta(ep) {
  try {
    // Strip blob URLs — they only work in the uploading browser
    const {
      audioUrl, videoUrl, _blobUrl,
      ...rest
    } = ep;
    const toSave = {
      ...rest,
      img:   rest.img?.startsWith("blob:")   ? FALLBACK_IMG : rest.img,
      cover: rest.cover?.startsWith("blob:") ? FALLBACK_IMG : rest.cover,
      savedAt: Date.now(),
    };
    // Use episode id as document id for easy lookup / overwrite
    const docRef = doc(db, "episodes", String(ep.id));
    await setDoc(docRef, toSave);
    return true;
  } catch (e) {
    console.warn("[firestore] save failed:", e);
    return false;
  }
}

/**
 * Fetch all episodes from Firestore, newest first.
 * Returns null on error so the app falls back to localStorage.
 */
async function cloudFetchEpisodes() {
  try {
    const q = query(collection(db, "episodes"), orderBy("savedAt", "desc"));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    return snap.docs.map(d => ({
      ...d.data(),
      _firestoreId: d.id,
      _storageMode: "cloud",
      // Restore playable URL from the cloudinary fields
      audioUrl: d.data().cloudAudioUrl || null,
      videoUrl: d.data().cloudVideoUrl || null,
      img:   d.data().cloudImgUrl || d.data().img   || FALLBACK_IMG,
      cover: d.data().cloudImgUrl || d.data().cover || FALLBACK_IMG,
    }));
  } catch (e) {
    console.warn("[firestore] fetch failed:", e);
    return null;
  }
}

/**
 * Delete an episode document from Firestore.
 */
async function cloudDeleteEpisode(id) {
  try {
    await deleteDoc(doc(db, "episodes", String(id)));
    return true;
  } catch (e) {
    console.warn("[firestore] delete failed:", e);
    return false;
  }
}

/* ── IndexedDB ───────────────────────────────────────────────── */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))       db.createObjectStore(STORE, { keyPath:"id" });
      if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE, { keyPath:"id" });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbPut(store, record) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const rq = tx.objectStore(store).put(record);
    rq.onsuccess = () => res(); rq.onerror = e => rej(e.target.error);
  });
}
async function idbGet(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const rq = db.transaction(store, "readonly").objectStore(store).get(id);
    rq.onsuccess = e => res(e.target.result || null); rq.onerror = e => rej(e.target.error);
  });
}
async function idbDelete(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const rq = db.transaction(store, "readwrite").objectStore(store).delete(id);
    rq.onsuccess = () => res(); rq.onerror = e => rej(e.target.error);
  });
}
const saveFileToIDB   = (id, file)  => idbPut(STORE, { id, file, type: file.type });
const saveThumbToIDB  = (id, blob)  => blob ? idbPut(THUMB_STORE, { id, blob }) : Promise.resolve();
const loadFileFromIDB = id => idbGet(STORE, id);
const loadThumbFromIDB= id => idbGet(THUMB_STORE, id);
const deleteFileFromIDB = async id => {
  await idbDelete(STORE, id).catch(() => {});
  await idbDelete(THUMB_STORE, id).catch(() => {});
};

/* ── localStorage metadata ───────────────────────────────────── */
function saveEpisodesToLocalStorage(eps) {
  try {
    const metas = eps.map(({ audioUrl, videoUrl, _blobUrl, ...rest }) => ({
      ...rest,
      img:   rest.img?.startsWith("blob:")   ? FALLBACK_IMG : rest.img,
      cover: rest.cover?.startsWith("blob:") ? FALLBACK_IMG : rest.cover,
    }));
    localStorage.setItem(META_KEY, JSON.stringify(metas));
  } catch (e) { console.warn("[local] meta save failed:", e); }
}

async function loadEpisodesFromLocal() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return [];
    const metas = JSON.parse(raw);
    const result = [];
    for (const meta of metas) {
      // Cloud URL present → use it directly, no IDB needed
      if (meta.cloudAudioUrl || meta.cloudVideoUrl) {
        result.push({
          ...meta,
          audioUrl: meta.cloudAudioUrl || null,
          videoUrl: meta.cloudVideoUrl || null,
          img:   meta.cloudImgUrl || meta.img   || FALLBACK_IMG,
          cover: meta.cloudImgUrl || meta.cover || FALLBACK_IMG,
          _storageMode: "cloud",
        });
        continue;
      }
      // Try IDB blob
      const stored = await loadFileFromIDB(meta.id).catch(() => null);
      if (stored?.file) {
        const blobUrl = URL.createObjectURL(stored.file);
        let imgUrl = meta.img, coverUrl = meta.cover;
        if (meta._hasThumbBlob) {
          const tr = await loadThumbFromIDB(meta.id).catch(() => null);
          if (tr?.blob) { const u = URL.createObjectURL(tr.blob); imgUrl = coverUrl = u; }
        }
        result.push({ ...meta, img: imgUrl, cover: coverUrl,
          audioUrl: meta.mediaType !== "video" ? blobUrl : null,
          videoUrl: meta.mediaType === "video"  ? blobUrl : null,
          _blobUrl: blobUrl, _storageMode: "local" });
        continue;
      }
      // IDB gone but public path hint exists
      if (meta._publicFileName && meta.mediaType) {
        const url = publicMediaUrl(meta.mediaType, meta._publicFileName);
        result.push({ ...meta,
          audioUrl: meta.mediaType !== "video" ? url : null,
          videoUrl: meta.mediaType === "video"  ? url : null,
          _storageMode: "public-path" });
      }
    }
    return result;
  } catch (e) { console.warn("[local] restore failed:", e); return []; }
}

/* ── merge cloud + local lists ───────────────────────────────── */
function mergeEpisodeLists(cloudEps, localEps) {
  if (!cloudEps) return localEps;
  const localMap = new Map(localEps.map(e => [String(e.id), e]));
  const merged   = [];
  for (const ce of cloudEps) {
    const local = localMap.get(String(ce.id));
    merged.push({
      ...(local || {}), ...ce,
      audioUrl: ce.cloudAudioUrl || local?.audioUrl || null,
      videoUrl: ce.cloudVideoUrl || local?.videoUrl || null,
      img:      ce.cloudImgUrl   || local?.img      || ce.img   || FALLBACK_IMG,
      cover:    ce.cloudImgUrl   || local?.cover    || ce.cover || FALLBACK_IMG,
      _storageMode: ce.cloudAudioUrl || ce.cloudVideoUrl ? "cloud" : (local?._storageMode || "cloud"),
    });
    if (local) localMap.delete(String(ce.id));
  }
  for (const local of localMap.values()) merged.push(local);
  return merged;
}

/* ═══════════════════════════════════════════════════════════════
   STATIC DATA
   ═══════════════════════════════════════════════════════════════ */
const EPS = [
  { id:1,num:"E001",title:"The Future of Gaming",host:"Alex Carter",guest:"Alex Carter",role:"Gaming Journalist & Host",dur:"28:45",date:"May 1, 2026",plays:"124K",tags:["Gaming","AI","Technology"],desc:"Discussion about AI, graphics evolution, and the future of open-world games. Alex explores how artificial intelligence is revolutionising NPC behaviour and procedural world generation.",img:"https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=500&q=80",cover:"https://images.unsplash.com/photo-1511512578047-dfb367046420?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"Intro & Gaming Evolution"},{t:"04:30",l:"AI in Modern Games"},{t:"12:15",l:"Graphics: Past to Future"},{t:"18:42",l:"Open-World Design Philosophy"},{t:"24:18",l:"The Next Decade of Gaming"}],featured:true,isNew:true},
  { id:2,num:"E002",title:"Tech Talks Daily",host:"Sarah Johnson",guest:"Sarah Johnson",role:"Tech Industry Analyst",dur:"35:12",date:"April 28, 2026",plays:"98K",tags:["Technology","Startups","Innovation"],desc:"Latest trends in AI tools, startups, and software innovation. Sarah breaks down the most impactful tech developments of 2026.",img:"https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=500&q=80",cover:"https://images.unsplash.com/photo-1518770660439-4636190af475?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"Welcome & Tech Headlines"},{t:"05:10",l:"AI Tools Reshaping Work"},{t:"14:30",l:"Startup Ecosystem Trends"},{t:"24:00",l:"Software Innovation Spotlight"},{t:"31:20",l:"Predictions for Q3 2026"}],featured:false,isNew:true},
  { id:3,num:"E003",title:"Mindset Mastery",host:"Daniel Brooks",guest:"Daniel Brooks",role:"Performance Coach & Author",dur:"22:18",date:"April 22, 2026",plays:"156K",tags:["Productivity","Psychology","Self-Improvement"],desc:"Building discipline, focus, and productivity habits for success. Daniel shares science-backed strategies for developing unshakeable focus.",img:"https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=500&q=80",cover:"https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"The Discipline Myth"},{t:"04:00",l:"Focus in a Distracted World"},{t:"10:45",l:"Building Keystone Habits"},{t:"16:30",l:"The Environment Design Method"},{t:"20:00",l:"Your 30-Day Challenge"}],featured:false,isNew:false},
  { id:4,num:"E004",title:"Startup Stories",host:"Emma Wilson",guest:"Emma Wilson",role:"Serial Entrepreneur & Investor",dur:"41:05",date:"April 18, 2026",plays:"87K",tags:["Startups","Entrepreneurship","Business"],desc:"Interviews with startup founders discussing the highs, lows, and hard-learned lessons from building companies from zero to acquisition.",img:"https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=500&q=80",cover:"https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"Meet Today's Founders"},{t:"06:10",l:"The Idea That Started It All"},{t:"14:30",l:"Fundraising War Stories"},{t:"24:00",l:"Scaling Through Crisis"},{t:"33:20",l:"The Exit"},{t:"38:45",l:"Advice for First-Time Founders"}],featured:false,isNew:false},
  { id:5,num:"E005",title:"Cyber World",host:"Ryan Lee",guest:"Ryan Lee",role:"Cybersecurity Expert & Ethical Hacker",dur:"30:27",date:"April 10, 2026",plays:"142K",tags:["Cybersecurity","Privacy","Technology"],desc:"Exploring cybersecurity, hacking culture, and online privacy. Ryan demystifies ethical hacking and reveals common security vulnerabilities.",img:"https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&q=80",cover:"https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"The State of Cybersecurity"},{t:"05:30",l:"Inside an Ethical Hacker's Mind"},{t:"12:15",l:"Common Vulnerabilities Exposed"},{t:"19:42",l:"Privacy in the Age of AI"},{t:"26:18",l:"Your Digital Security Checklist"}],featured:false,isNew:false},
  { id:6,num:"E006",title:"Cinema Breakdown",host:"Olivia Martin",guest:"Olivia Martin",role:"Film Critic & Director",dur:"26:50",date:"April 5, 2026",plays:"76K",tags:["Film","Entertainment","Storytelling"],desc:"Deep dives into blockbuster movies, storytelling, and cinematography. Olivia analyses the visual language of modern cinema.",img:"https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80",cover:"https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"This Week in Cinema"},{t:"04:30",l:"Anatomy of a Perfect Scene"},{t:"11:15",l:"The Streaming Revolution"},{t:"18:42",l:"Cinematography Masterclass"},{t:"24:00",l:"Films You Need to Watch"}],featured:false,isNew:false},
  { id:7,num:"E007",title:"Level Up Fitness",host:"Chris Adams",guest:"Chris Adams",role:"Certified Trainer & Nutrition Coach",dur:"33:40",date:"March 30, 2026",plays:"112K",tags:["Fitness","Health","Lifestyle"],desc:"Fitness routines, fat loss strategies, and healthy lifestyle discussions. Chris provides evidence-based training advice.",img:"https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=500&q=80",cover:"https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1400&q=85",audioUrl:null,mediaType:"audio",chapters:[{t:"00:00",l:"Fitness Myths Busted"},{t:"05:30",l:"The Science of Fat Loss"},{t:"13:15",l:"Building an Effective Routine"},{t:"21:42",l:"Nutrition: What Actually Matters"},{t:"29:00",l:"Sustainable Lifestyle Changes"}],featured:false,isNew:false},
];

const GUESTS = [
  { id:1,name:"Dr. Anna Lembke", role:"Stanford Neuroscientist",      ep:"E047",img:"https://images.unsplash.com/photo-1559757175-5700dde675bc?w=400&q=80",bio:"Professor at Stanford and bestselling author of Dopamine Nation. Leading voice on addiction science.",tw:"@annalembke"},
  { id:2,name:"Vivek Sharma",    role:"Partner @ Y Combinator",       ep:"E046",img:"https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&q=80",bio:"3x founder, 2x exit. Partner at Y Combinator where he's helped launch over 400 companies.",tw:"@viveksharma"},
  { id:3,name:"Priya Anand",     role:"AI Researcher, MIT Media Lab",  ep:"E045",img:"https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&q=80",bio:"Research at the intersection of AI, labor economics, and organisational behaviour.",tw:"@priyanand_ai"},
  { id:4,name:"Dr. Renata Costa",role:"Climate Psychologist",          ep:"E044",img:"https://images.unsplash.com/photo-1607746882042-944635dfe10e?w=400&q=80",bio:"Pioneer of climate psychology. Author of four books and founder of the Climate Minds Institute.",tw:"@renatacosta"},
  { id:5,name:"Marcus Bell",     role:"Creative Director, Pixar",      ep:"E048",img:"https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&q=80",bio:"Three-time Academy Award winner and creative director at Pixar.",tw:"@marcusbell"},
  { id:6,name:"Sofia Reyes",     role:"Behavioral Economist, Harvard", ep:"E042",img:"https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&q=80",bio:"Harvard professor whose work on behavioural economics has influenced WHO policy.",tw:"@sofiareyes"},
];

const PLATFORMS = [
  { name:"Spotify",        icon:"🎵",color:"#1DB954",sub:"2.1M listeners",  url:"https://open.spotify.com"},
  { name:"Apple Podcasts", icon:"🎙️",color:"#BF5AF2",sub:"1.8M listeners",  url:"https://podcasts.apple.com"},
  { name:"YouTube",        icon:"▶️", color:"#FF0000",sub:"890K subscribers",url:"https://youtube.com"},
  { name:"Amazon Music",   icon:"♪", color:"#00A8E1",sub:"340K listeners",  url:"https://music.amazon.com"},
  { name:"Google Podcasts",icon:"🎧",color:"#4285F4",sub:"210K listeners",  url:"https://podcasts.google.com"},
  { name:"RSS Feed",       icon:"◉", color:"#F5A623",sub:"Open access",     url:"https://signalandnoise.fm/feed"},
];

const UPLOAD_CATEGORIES = {
  audio:{ id:"audio",label:"Audio Podcast",icon:"🎙️",color:"var(--a)",  accent:"rgba(245,166,35,.15)",border:"rgba(245,166,35,.3)",  accepted:"audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.wma",exts:["mp3","wav","m4a","aac","ogg","flac","opus","wma","mpeg","mp4a"],mimePrefix:"audio/",formats:[".mp3",".wav",".m4a",".aac",".ogg",".flac",".opus",".wma"],maxMB:800,  dropLabel:"DRAG & DROP AUDIO FILES HERE OR CLICK TO BROWSE",mobileLabel:"TAP TO BROWSE AUDIO FILES",formatsLine:"MP3 · WAV · M4A · AAC · OGG · FLAC · OPUS · WMA",desc:"Long-form interview or solo audio episodes"},
  video:{ id:"video",label:"Video Podcast", icon:"🎬",color:"#a78bfa",  accent:"rgba(167,139,250,.12)",border:"rgba(167,139,250,.28)",accepted:"video/*,.mp4,.mov,.webm,.avi,.mkv,.m4v",                    exts:["mp4","mov","webm","avi","mkv","m4v","ogv"],              mimePrefix:"video/",formats:[".mp4",".mov",".webm",".avi",".mkv",".m4v"],        maxMB:2048, dropLabel:"DRAG & DROP VIDEO FILES HERE OR CLICK TO BROWSE",mobileLabel:"TAP TO BROWSE VIDEO FILES",formatsLine:"MP4 · MOV · WEBM · AVI · MKV · M4V",             desc:"Full video episodes with host & guest on camera"},
  song: { id:"song", label:"Songs",         icon:"🎵",color:"#34d399",  accent:"rgba(52,211,153,.1)",  border:"rgba(52,211,153,.25)", accepted:"audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac",                    exts:["mp3","wav","m4a","aac","ogg","flac"],                    mimePrefix:"audio/",formats:[".mp3",".wav",".m4a",".aac",".ogg",".flac"],          maxMB:200,  dropLabel:"DRAG & DROP SONG FILES HERE OR CLICK TO BROWSE",  mobileLabel:"TAP TO BROWSE SONG FILES",formatsLine:"MP3 · WAV · M4A · AAC · OGG · FLAC",             desc:"Music tracks, jingles, and intro/outro songs"},
};

/* ── Podcast content categories ──────────────────────────────── */
const PODCAST_CATEGORIES = [
  { id:"all",        label:"All",          icon:"🎙",  color:"var(--a)",   accent:"rgba(245,166,35,.12)",  border:"rgba(245,166,35,.28)"  },
  { id:"music",      label:"Music",        icon:"🎵",  color:"#ec4899",    accent:"rgba(236,72,153,.1)",   border:"rgba(236,72,153,.25)"  },
  { id:"sports",     label:"Sports",       icon:"⚽",  color:"#22d3ee",    accent:"rgba(34,211,238,.1)",   border:"rgba(34,211,238,.25)"  },
  { id:"sports_songs",label:"Sports Songs",icon:"🏆",  color:"#f472b6",    accent:"rgba(244,114,182,.1)",  border:"rgba(244,114,182,.25)" },
  { id:"games",      label:"Games",        icon:"🎮",  color:"#a78bfa",    accent:"rgba(167,139,250,.12)", border:"rgba(167,139,250,.28)" },
  { id:"technology", label:"Technology",   icon:"💻",  color:"#60a5fa",    accent:"rgba(96,165,250,.1)",   border:"rgba(96,165,250,.25)"  },
  { id:"comedy",     label:"Comedy",       icon:"😂",  color:"#fbbf24",    accent:"rgba(251,191,36,.1)",   border:"rgba(251,191,36,.25)"  },
  { id:"news",       label:"News",         icon:"📰",  color:"#94a3b8",    accent:"rgba(148,163,184,.1)",  border:"rgba(148,163,184,.22)" },
  { id:"education",  label:"Education",    icon:"📚",  color:"#34d399",    accent:"rgba(52,211,153,.1)",   border:"rgba(52,211,153,.25)"  },
  { id:"lifestyle",  label:"Lifestyle",    icon:"🌟",  color:"#fb923c",    accent:"rgba(251,146,60,.1)",   border:"rgba(251,146,60,.25)"  },
  { id:"health",     label:"Health",       icon:"❤️",  color:"#f87171",    accent:"rgba(248,113,113,.1)",  border:"rgba(248,113,113,.22)" },
  { id:"other",      label:"Other",        icon:"📻",  color:"var(--g)",   accent:"rgba(138,134,128,.1)",  border:"rgba(138,134,128,.22)" },
];

function validateMediaFile(f, catId) {
  const cat = UPLOAD_CATEGORIES[catId];
  if (!f) return "No file selected.";
  const ext = f.name.split(".").pop().toLowerCase();
  if (!f.type.startsWith(cat.mimePrefix) && !cat.exts.includes(ext))
    return `"${f.name}" is not a supported ${cat.label} file.\nAccepted: ${cat.formats.join(" · ")}`;
  if (f.size > cat.maxMB * 1024 * 1024) return `"${f.name}" exceeds the ${cat.maxMB} MB size limit.`;
  if (f.size === 0) return `"${f.name}" appears to be empty (0 bytes).`;
  return null;
}

function fmtBytes(b) {
  if (b < 1024)           return `${b} B`;
  if (b < 1024 * 1024)    return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(2)} MB`;
}

function detectDuration(blobUrl, isVideo) {
  return new Promise(resolve => {
    const el = isVideo ? document.createElement("video") : new Audio();
    el.src = blobUrl; el.preload = "metadata";
    const done = d => { el.src = ""; resolve(d); };
    el.addEventListener("loadedmetadata", () => done(el.duration));
    el.addEventListener("error", () => done(NaN));
    setTimeout(() => done(NaN), 6000);
  });
}

/* ═══════════════════════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Serif+Display:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;600&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:#070707;color:#f0ede6;font-family:'DM Sans',system-ui,sans-serif;overflow-x:hidden;-webkit-font-smoothing:antialiased;line-height:1.5}
:root{
  --a:#f5a623;--a2:rgba(245,166,35,.14);--a3:rgba(245,166,35,.32);
  --r:#e8441a;--c:#f0ede6;--g:#8a8680;
  --d:#070707;--d2:#0d0d0d;--d3:#131313;--card:#101010;--bdr:rgba(240,237,230,.07);
  --cloud-c:#60a5fa;--cloud-bg:rgba(96,165,250,.1);--cloud-bdr:rgba(96,165,250,.28);
  --local-c:#4ade80;--local-bg:rgba(74,222,128,.1);--local-bdr:rgba(74,222,128,.25);
  --container-max:1220px;--container-padding:clamp(16px,4vw,40px);
  --fs-h1:clamp(40px,8vw,116px);--fs-h2:clamp(32px,6vw,80px);--fs-h3:clamp(24px,4vw,34px);
  --fs-body:clamp(14px,2vw,16px);--fs-small:clamp(11px,1.5vw,13px);--fs-xs:clamp(9px,1.2vw,11px);
  --sp-xs:4px;--sp-sm:8px;--sp-md:16px;--sp-lg:24px;--sp-xl:32px;--sp-2xl:48px;--sp-3xl:64px;
  --navbar-h:68px;--player-h:0px;
}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:var(--d)}
::-webkit-scrollbar-thumb{background:var(--a);border-radius:2px}
::selection{background:var(--a);color:#070707}

.bb{font-family:'Bebas Neue',sans-serif;letter-spacing:.02em;line-height:.92}
.sf{font-family:'DM Serif Display',serif}
.mn{font-family:'JetBrains Mono',monospace}

body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.045'/%3E%3C/svg%3E");pointer-events:none;z-index:9990;opacity:.38}
.gbg{background-image:linear-gradient(rgba(240,237,230,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(240,237,230,.028) 1px,transparent 1px);background-size:56px 56px}

@keyframes fadeUp{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes waveBar{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
@keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes glow{0%,100%{box-shadow:0 0 18px var(--a3)}50%{box-shadow:0 0 36px var(--a3),0 0 70px rgba(245,166,35,.12)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes scanX{from{transform:translateX(-100%)}to{transform:translateX(100vw)}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.93)}}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@keyframes ripple{0%{transform:scale(1);opacity:.5}100%{transform:scale(2.8);opacity:0}}
@keyframes slideInR{from{transform:translateX(100%)}to{transform:translateX(0)}}
@keyframes shimmer{0%{background-position:-600px 0}100%{background-position:600px 0}}
@keyframes uploadPulse{0%,100%{opacity:.6}50%{opacity:1}}
@keyframes progressStripe{0%{background-position:0 0}100%{background-position:40px 0}}

/* ── Video fullscreen ───────────────────────────────────────── */
:fullscreen { background:#000 !important; }
:-webkit-full-screen { background:#000 !important; }
:fullscreen video { width:100% !important; height:100% !important; max-height:100vh !important; object-fit:contain; }
:-webkit-full-screen video { width:100% !important; height:100% !important; object-fit:contain; }
/* When the wrapper div is fullscreen, stretch it and show controls */
:fullscreen > video { display:block; }
:fullscreen .vid-ctrl-overlay { opacity:1; pointer-events:auto; }

.fu{animation:fadeUp .7s cubic-bezier(.16,1,.3,1) both}
.d1{animation-delay:.08s}.d2{animation-delay:.16s}.d3{animation-delay:.24s}.d4{animation-delay:.32s}

.wrap{max-width:var(--container-max);margin:0 auto;padding:0 var(--container-padding);width:100%}
.sec{padding:var(--sp-3xl) 0}.sec-sm{padding:var(--sp-2xl) 0}

.card{background:var(--card);border:1px solid var(--bdr);border-radius:2px;transition:border-color .3s,box-shadow .3s}
.card:hover{border-color:rgba(245,166,35,.18);box-shadow:0 8px 36px rgba(0,0,0,.5)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:'DM Sans',sans-serif;font-weight:600;font-size:var(--fs-xs);letter-spacing:.07em;text-transform:uppercase;cursor:pointer;transition:all .22s;border:none;outline:none;min-height:44px;touch-action:manipulation}
.btn-a{background:var(--a);color:#070707;padding:8px 24px;clip-path:polygon(0 0,calc(100% - 11px) 0,100% 11px,100% 100%,11px 100%,0 calc(100% - 11px));position:relative;overflow:hidden;white-space:nowrap}
.btn-a::before{content:'';position:absolute;inset:0;background:rgba(255,255,255,.15);transform:translateX(-100%);transition:transform .3s}
.btn-a:hover::before{transform:translateX(0)}
.btn-a:hover{transform:scale(1.02);box-shadow:0 8px 30px var(--a3)}
.btn-g{background:transparent;color:var(--c);padding:12px 26px;border:1px solid var(--bdr);clip-path:polygon(0 0,calc(100% - 11px) 0,100% 11px,100% 100%,11px 100%,0 calc(100% - 11px));white-space:nowrap}
.btn-g:hover{border-color:var(--a);color:var(--a)}

.nl{font-family:'JetBrains Mono',monospace;font-size:var(--fs-xs);font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:var(--g);background:none;border:none;cursor:pointer;position:relative;padding:4px 0;transition:color .2s;white-space:nowrap;min-height:44px;display:inline-flex;align-items:center}
.nl::after{content:'';position:absolute;bottom:-2px;left:0;width:0;height:1px;background:var(--a);transition:width .3s}
.nl:hover,.nl.act{color:var(--c)}.nl.act::after,.nl:hover::after{width:100%}

.tag{display:inline-flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:var(--fs-xs);font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:2px;background:var(--a2);color:var(--a);border:1px solid rgba(245,166,35,.22);white-space:nowrap}
.tag-r{background:rgba(232,68,26,.1);color:var(--r);border-color:rgba(232,68,26,.22)}

.field{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--bdr);color:var(--c);font-family:'DM Sans',sans-serif;font-size:var(--fs-small);padding:13px 16px;outline:none;border-radius:2px;transition:border-color .2s,background .2s;min-height:44px;-webkit-appearance:none;appearance:none}
.field:focus{border-color:var(--a);background:rgba(245,166,35,.03)}
.field::placeholder{color:var(--g)}
textarea.field{resize:vertical;min-height:100px}
select.field{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238a8680' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:36px}

.prog{height:4px;background:rgba(255,255,255,.1);border-radius:2px;cursor:pointer;position:relative;overflow:hidden}
.progf{height:100%;background:linear-gradient(90deg,var(--a),var(--r));border-radius:2px;transition:width .15s linear}
.wb{width:3px;border-radius:2px;background:var(--a);animation:waveBar .75s ease-in-out infinite;transform-origin:bottom;flex-shrink:0}
.ld{width:8px;height:8px;background:var(--r);border-radius:50%;animation:pulse 1.4s ease-in-out infinite;box-shadow:0 0 8px rgba(232,68,26,.55);flex-shrink:0}
.hl{transition:transform .3s cubic-bezier(.34,1.56,.64,1)}.hl:hover{transform:translateY(-4px)}
.skel{background:linear-gradient(90deg,#1a1a1a 0%,#252525 50%,#1a1a1a 100%);background-size:600px 100%;animation:shimmer 1.6s infinite;border-radius:2px}

/* Storage badges */
.storage-badge{display:inline-flex;align-items:center;gap:4px;font-family:'JetBrains Mono';font-size:8px;padding:2px 7px;border-radius:2px;letter-spacing:.07em;font-weight:700}
.storage-badge.cloud{background:var(--cloud-bg);color:var(--cloud-c);border:1px solid var(--cloud-bdr)}
.storage-badge.local{background:var(--local-bg);color:var(--local-c);border:1px solid var(--local-bdr)}
.storage-badge.public-path{background:var(--cloud-bg);color:var(--cloud-c);border:1px solid var(--cloud-bdr)}
.storage-badge.syncing{background:rgba(245,166,35,.12);color:var(--a);border:1px solid rgba(245,166,35,.3);animation:uploadPulse 1.2s ease-in-out infinite}

/* Upload progress */
.upload-progress-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;position:relative;margin-top:8px}
.upload-progress-fill{height:100%;border-radius:2px;transition:width .25s linear}
.upload-progress-fill.cloud{background:linear-gradient(90deg,var(--cloud-c),#818cf8)}
.upload-progress-fill.local{background:linear-gradient(90deg,var(--local-c),#34d399)}

/* Layout */
.g2{display:grid;gap:24px}.g3{display:grid;gap:24px}.g4{display:grid;gap:24px}
img{max-width:100%;height:auto;display:block}

@media(min-width:768px){.g2{grid-template-columns:repeat(2,1fr)}.g3{grid-template-columns:repeat(2,1fr)}.g4{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1024px){.g3{grid-template-columns:repeat(3,1fr)}.g4{grid-template-columns:repeat(4,1fr)}.hm{display:flex!important}}
@media(max-width:1023px){.hm{display:none!important}.wrap{padding:0 16px}.sec{padding:48px 0}}
@media(max-width:767px){.g2,.g3,.g4{grid-template-columns:1fr!important}.wrap{padding:0 16px}}

.ep-grid{display:grid;grid-template-columns:1fr clamp(280px,30%,360px);gap:clamp(28px,5vw,56px);align-items:start}
@media(max-width:900px){.ep-grid{grid-template-columns:1fr!important;gap:28px}.ep-sidebar-order{order:2}.ep-main-order{order:1}}
.ep-player-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
@media(max-width:600px){.ep-speed-pills{display:none!important}}

.upload-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:32px;align-items:start}
@media(max-width:900px){.upload-grid{grid-template-columns:1fr!important;gap:24px}.upload-sidebar{order:2}.upload-main{order:1}}

.archive-grid{display:grid;grid-template-columns:1fr 260px;gap:40px;align-items:start}
@media(max-width:900px){.archive-grid{grid-template-columns:1fr!important}.archive-sidebar{display:none!important}}

.pub-ep-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(74,222,128,.04);border:1px solid rgba(74,222,128,.15);border-radius:3px;flex-wrap:wrap}

/* Overlays */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);animation:fadeIn .25s ease}
.modal-box{background:#111;border:1px solid var(--bdr);border-radius:4px;padding:36px;max-width:460px;width:100%;position:relative;animation:fadeUp .35s cubic-bezier(.16,1,.3,1)}
.search-overlay{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:1500;display:flex;flex-direction:column;align-items:center;padding:80px 20px 40px;backdrop-filter:blur(16px);animation:fadeIn .2s ease}
.search-input-big{background:transparent;border:none;border-bottom:2px solid var(--a);color:var(--c);font-family:'Bebas Neue',sans-serif;font-size:clamp(36px,7vw,72px);letter-spacing:.04em;outline:none;text-align:center;width:100%;max-width:800px;padding:12px 0;caret-color:var(--a)}
.search-input-big::placeholder{color:rgba(245,166,35,.25)}
.nl-popup{position:fixed;bottom:100px;right:28px;z-index:1400;background:#111;border:1px solid var(--bdr);border-radius:4px;padding:28px;width:320px;box-shadow:0 24px 64px rgba(0,0,0,.7);animation:fadeUp .45s cubic-bezier(.16,1,.3,1)}
.toast{position:fixed;top:80px;right:24px;z-index:3000;background:#111;border:1px solid var(--bdr);border-left:3px solid var(--a);padding:14px 18px;border-radius:3px;font-size:13px;font-weight:500;color:var(--c);box-shadow:0 12px 36px rgba(0,0,0,.6);animation:fadeUp .4s cubic-bezier(.16,1,.3,1)}
.btt{position:fixed;bottom:28px;right:28px;z-index:800;width:42px;height:42px;border-radius:50%;background:var(--a2);border:1px solid rgba(245,166,35,.28);color:var(--a);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .25s;animation:fadeIn .3s ease}
.btt:hover{background:var(--a);color:#070707;transform:translateY(-2px)}
.kbd{display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:4px;padding:1px 7px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--g);line-height:1.8}
.review-track{display:flex;gap:16px;animation:ticker 40s linear infinite;white-space:nowrap}
.review-track:hover{animation-play-state:paused}
.trend-row{display:flex;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid var(--bdr);cursor:pointer;transition:all .2s}
.trend-row:hover{padding-left:6px}.trend-row:last-child{border-bottom:none}

body.light{background:#f5f3ef;color:#1a1815}
body.light .card{background:#fff;border-color:rgba(0,0,0,.08)}
body.light .field{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.1);color:#1a1815}
body.light .field::placeholder{color:#9a9690}
body.light .nl{color:#6a6660}
body.light .skel{background:linear-gradient(90deg,#e8e6e2 0%,#f0eeea 50%,#e8e6e2 100%);background-size:600px 100%}
body.light .modal-box,.body.light .nl-popup{background:#fff}
body.light .toast{background:#fff}
body.light .search-input-big{color:#1a1815}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important}}
@media(max-width:479px){a,button,[role="button"]{min-height:44px;-webkit-tap-highlight-color:transparent}.wrap{padding:0 8px}.toast{top:auto;bottom:100px;right:8px;left:8px}.btt{bottom:90px;right:8px}.nl-popup{bottom:0!important;right:0!important;left:0!important;width:100%!important;border-radius:16px 16px 0 0!important}.kbd-hint{display:none!important}}
@media(max-width:767px){.kbd-hint{display:none!important}}
body.player-active .btt{bottom:120px}
body.player-active .nl-popup{bottom:118px}
@media(max-width:479px){body.player-active .btt{bottom:120px}body.player-active .nl-popup{bottom:0!important;bottom:118px!important}}

/* Video sidebar thumbnail hover */
.thumb-wrap{position:relative;flex-shrink:0;width:130px;height:74px;border-radius:4px;overflow:hidden;background:#111}
.thumb-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);opacity:0;transition:opacity .2s}
.thumb-wrap:hover .thumb-overlay,.thumb-wrap:active .thumb-overlay{opacity:1}
@media(max-width:767px){.thumb-wrap{width:100px;height:58px}}

/* Video modal responsive */
.vid-modal-body{flex-direction:column;overflow:hidden}
@media(min-width:768px){.vid-modal-body{flex-direction:row!important}}

/* Mobile: video takes ~55% height, sidebar takes ~45% */
.vid-video-col{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#000;min-height:0}
@media(max-width:767px){.vid-video-col{flex:0 0 auto;height:55dvh;min-height:200px}}
@media(min-width:768px){.vid-video-col{flex:1}}

.vid-sidebar{overflow-y:auto;display:flex;flex-direction:column;flex-shrink:0;background:#0a0a0a}
/* Mobile: sidebar scrolls below video */
@media(max-width:767px){
  .vid-sidebar{flex:1;min-height:0;border-left:none!important;border-top:1px solid rgba(255,255,255,.06)!important;width:100%!important;max-height:none!important}
}
@media(min-width:768px){.vid-sidebar{max-height:none!important;width:300px!important;flex-shrink:0!important;border-top:none!important;border-left:1px solid rgba(255,255,255,.06)!important}}
@media(min-width:1024px){.vid-sidebar{width:340px!important}}

/* Video controls — mobile-friendly */
.vid-ctrl-row{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-height:44px}
@media(max-width:479px){
  .vid-ctrl-row{flex-wrap:wrap;gap:4px;padding:6px 12px!important}
  .vid-speed-pills{display:none!important}
  .vid-vol-wrap{display:none!important}
  .vid-mute-sm{display:flex!important}
  .vid-time{font-size:10px!important}
}
@media(max-width:767px){
  .vid-speed-pills button{padding:4px 7px!important;font-size:8px!important}
}

/* Episode cards grid — mobile */
@media(max-width:479px){
  .ep-cards-grid{grid-template-columns:1fr!important;gap:10px!important}
}
@media(max-width:767px){
  .ep-cards-grid{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))!important}
}
@media print{body{background:white;color:black}.btt,.toast{display:none!important}}
`;

/* ═══════════════════════════════════════════════════════════════
   HOOKS
   ═══════════════════════════════════════════════════════════════ */
function useScrollY() {
  const [y, setY] = useState(0);
  useEffect(() => {
    const fn = () => setY(window.scrollY);
    window.addEventListener("scroll", fn, { passive:true }); fn();
    return () => window.removeEventListener("scroll", fn);
  }, []);
  return y;
}

function useInView(ref, threshold = 0.12) {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVis(true); obs.disconnect(); } }, { threshold });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return vis;
}

function Rv({ children, delay = 0, className = "", style = {} }) {
  const ref = useRef(null);
  const vis = useInView(ref);
  return (
    <div ref={ref} className={className} style={{ opacity:vis?1:0, transform:vis?"translateY(0)":"translateY(26px)", transition:`opacity .7s cubic-bezier(.16,1,.3,1) ${delay}s, transform .7s cubic-bezier(.16,1,.3,1) ${delay}s`, ...style }}>
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SMALL SHARED COMPONENTS
   ═══════════════════════════════════════════════════════════════ */
function WaveBars({ count=7, color="var(--a)", playing=true, height=20 }) {
  return (
    <div style={{ display:"flex", gap:3, alignItems:"flex-end", height }}>
      {Array.from({length:count},(_,i) => (
        <div key={i} className="wb" style={{ height:`${(40+Math.random()*60)*height/100}px`, background:color, animationDelay:`${i*0.09}s`, animationPlayState:playing?"running":"paused", opacity:playing?1:0.3 }} />
      ))}
    </div>
  );
}

function Ticker() {
  const items=["Signal & Noise","New Episodes Every Friday","Follow on Spotify","#1 Podcast 2026","1M+ Monthly Listeners","New Episode Out Now","Deep Conversations","Season 3"];
  return (
    <div style={{ overflow:"hidden", borderTop:"1px solid var(--bdr)", borderBottom:"1px solid var(--bdr)", background:"var(--d2)", padding:"10px 0" }}>
      <div style={{ display:"flex", animation:"ticker 22s linear infinite", whiteSpace:"nowrap" }}>
        {[...items,...items].map((t,i) => (
          <span key={i} style={{ display:"inline-flex", alignItems:"center", gap:18, padding:"0 28px" }}>
            <span style={{ fontFamily:"'JetBrains Mono'", fontSize:9, letterSpacing:".13em", textTransform:"uppercase", color:"var(--g)" }}>{t}</span>
            <span style={{ color:"var(--a)", fontSize:7, opacity:.7 }}>◆</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function StorageBadge({ mode }) {
  const cfgs = { cloud:{label:"☁ CLOUD",cls:"cloud"}, local:{label:"💾 LOCAL",cls:"local"}, "public-path":{label:"🌐 PUBLIC",cls:"public-path"}, syncing:{label:"↑ SYNCING",cls:"syncing"} };
  const cfg = cfgs[mode] || cfgs.local;
  return <span className={`storage-badge ${cfg.cls}`}>{cfg.label}</span>;
}

function ServerStatusBadge({ online }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:5, padding:"3px 9px", borderRadius:2, background:online?"rgba(74,222,128,.1)":"rgba(245,166,35,.1)", border:`1px solid ${online?"rgba(74,222,128,.25)":"rgba(245,166,35,.25)"}` }}>
      <div style={{ width:6, height:6, borderRadius:"50%", background:online?"#4ade80":"var(--a)", animation:"pulse 1.4s ease-in-out infinite", flexShrink:0 }} />
      <span className="mn" style={{ fontSize:8, color:online?"#4ade80":"var(--a)", letterSpacing:".08em" }}>{online?"☁ CLOUD ON":"💾 LOCAL"}</span>
    </div>
  );
}

function ProgressRing({ pct=65, size=56, color="var(--a)" }) {
  const r=(size-6)/2, circ=2*Math.PI*r, offset=circ-(pct/100)*circ;
  return (
    <svg width={size} height={size} style={{ transform:"rotate(-90deg)", flexShrink:0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={3} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={3} strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" style={{ transition:"stroke-dashoffset .6s ease" }} />
    </svg>
  );
}

function SkeletonCard() {
  return (
    <div className="card" style={{ overflow:"hidden" }}>
      <div className="skel" style={{ height:210 }} />
      <div style={{ padding:"18px 20px" }}>
        <div className="skel" style={{ height:9, width:"35%", marginBottom:12 }} />
        <div className="skel" style={{ height:16, width:"90%", marginBottom:8 }} />
        <div className="skel" style={{ height:16, width:"70%", marginBottom:14 }} />
        <div className="skel" style={{ height:11, width:"55%" }} />
      </div>
    </div>
  );
}

function Toast({ msg, onDone }) {
  useEffect(() => { const t=setTimeout(onDone,2800); return ()=>clearTimeout(t); }, []);
  return <div className="toast">{msg}</div>;
}

function BackToTop() {
  const y = useScrollY();
  if (y < 600) return null;
  return <button className="btt" onClick={() => window.scrollTo({top:0,behavior:"smooth"})}>↑</button>;
}

function AnimCounter({ target, suffix="", dur=1800 }) {
  const [val,setVal]=useState(0); const ref=useRef(null); const vis=useInView(ref);
  useEffect(() => {
    if (!vis) return;
    const start=performance.now(), num=parseFloat(String(target).replace(/[^\d.]/g,""))||0;
    const tick=now => { const p=Math.min((now-start)/dur,1),ease=1-Math.pow(1-p,3); setVal(num<10?parseFloat((ease*num).toFixed(1)):Math.floor(ease*num)); if(p<1)requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  },[vis]);
  const fmt=n => { if(String(target).includes("M"))return(n/1000000>.1?(n/1000000).toFixed(1):"0")+"M"; if(n>=1000)return(n/1000).toFixed(0)+"K"; return String(n); };
  return <span ref={ref}>{fmt(val)}{suffix}</span>;
}

/* ── ThumbnailPicker ─────────────────────────────────────────── */
function ThumbnailPicker({ value, onChange }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const handle = f => { if (!f||!f.type.startsWith("image/")) return; onChange(URL.createObjectURL(f), f.name, f); };
  return (
    <div style={{ marginBottom:14 }}>
      <label className="mn" style={{ fontSize:8, color:"var(--g)", letterSpacing:".1em", display:"block", marginBottom:6, textTransform:"uppercase" }}>Thumbnail / Cover Art</label>
      <input ref={ref} type="file" accept="image/*" style={{ display:"none" }} onChange={e=>{const f=e.target.files?.[0];if(f)handle(f);e.target.value="";}} />
      <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
        <div onClick={()=>ref.current?.click()} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files?.[0])}}
          style={{ width:88, height:88, borderRadius:3, flexShrink:0, cursor:"pointer", overflow:"hidden", border:`2px dashed ${drag?"var(--a)":"var(--bdr)"}`, background:drag?"rgba(245,166,35,.07)":"rgba(255,255,255,.03)", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:4, transition:"all .2s" }}>
          {value ? <img src={value} alt="thumb" style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : <><span style={{fontSize:22}}>🖼️</span><span className="mn" style={{fontSize:7,color:"var(--g)",letterSpacing:".06em",textAlign:"center"}}>CLICK OR DROP</span></>}
        </div>
        <div style={{ flex:1 }}>
          <p style={{ fontSize:11, color:"var(--g)", lineHeight:1.65, marginBottom:8 }}>Upload a square image (JPG, PNG, WEBP). Recommended: <strong style={{color:"var(--c)"}}>1400×1400px</strong>.</p>
          <div style={{ display:"flex", gap:7 }}>
            <button onClick={()=>ref.current?.click()} style={{ padding:"5px 12px", background:"rgba(255,255,255,.05)", border:"1px solid var(--bdr)", borderRadius:2, cursor:"pointer", color:"var(--c)", fontFamily:"'JetBrains Mono'", fontSize:8, transition:"all .2s" }} onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--a)";e.currentTarget.style.color="var(--a)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.color="var(--c)"}}>Browse Image</button>
            {value && <button onClick={()=>onChange(null,null,null)} style={{ padding:"5px 12px", background:"rgba(232,68,26,.07)", border:"1px solid rgba(232,68,26,.22)", borderRadius:2, cursor:"pointer", color:"var(--r)", fontFamily:"'JetBrains Mono'", fontSize:8 }}>Remove</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── FileRow ─────────────────────────────────────────────────── */
function FileRow({ item, idx, onRemove, onMetaChange, catId }) {
  const [open, setOpen] = useState(idx === 0);
  const cat=UPLOAD_CATEGORIES[catId]||UPLOAD_CATEGORIES.audio, isVideo=catId==="video", isSong=catId==="song";
  return (
    <div style={{ background:item.error?"rgba(232,68,26,.06)":item.done?"rgba(74,222,128,.05)":"rgba(255,255,255,.03)", border:`1px solid ${item.error?"rgba(232,68,26,.28)":item.done?"rgba(74,222,128,.2)":"var(--bdr)"}`, borderRadius:3, marginBottom:10, overflow:"hidden" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", cursor:"pointer" }} onClick={()=>setOpen(o=>!o)}>
        {item.meta?.thumbnailUrl ? <img src={item.meta.thumbnailUrl} alt="" style={{ width:36,height:36,objectFit:"cover",borderRadius:2,flexShrink:0,border:"1px solid var(--bdr)" }} /> : <span style={{fontSize:18,flexShrink:0}}>{item.error?"⚠️":item.done?"✅":cat.icon}</span>}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:12, fontWeight:600, color:"var(--c)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.meta?.title||item.file.name}</div>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:2 }}>
            <span className="mn" style={{ fontSize:9, color:"var(--g)" }}>{fmtBytes(item.file.size)}{item.duration?` · ${item.duration}`:""}</span>
            {item.storageMode && <StorageBadge mode={item.uploading?"syncing":item.storageMode} />}
          </div>
        </div>
        {item.error && <span style={{ fontSize:10, color:"var(--r)", flexShrink:0, fontFamily:"'JetBrains Mono'" }}>ERROR</span>}
        {item.done  && <span style={{ fontSize:10, color:"rgba(74,222,128,.8)", flexShrink:0, fontFamily:"'JetBrains Mono'" }}>PUBLISHED</span>}
        <button onClick={e=>{e.stopPropagation();onRemove(idx)}} style={{ background:"none",border:"none",cursor:"pointer",color:"var(--g)",fontSize:14,lineHeight:1,flexShrink:0,padding:4,transition:"color .2s" }} onMouseEnter={e=>e.target.style.color="#e8441a"} onMouseLeave={e=>e.target.style.color="var(--g)"}>✕</button>
        <span style={{ color:"var(--g)", fontSize:10, flexShrink:0, transition:"transform .2s", transform:open?"rotate(180deg)":"none" }}>▾</span>
      </div>
      {item.error && <div style={{ padding:"0 16px 12px", fontSize:11, color:"var(--r)", lineHeight:1.6, whiteSpace:"pre-line" }}>{item.error}</div>}
      {item.uploading && (
        <div style={{ padding:"0 16px 10px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
            <span className="mn" style={{ fontSize:8, color:item.uploadMode==="cloud"?"var(--cloud-c)":"var(--local-c)", letterSpacing:".08em" }}>{item.uploadMode==="cloud"?"☁ CLOUD UPLOAD":"💾 LOCAL SAVE"}</span>
            <span className="mn" style={{ fontSize:8, color:"var(--g)" }}>{item.uploadPct||0}%</span>
          </div>
          <div className="upload-progress-bar"><div className={`upload-progress-fill ${item.uploadMode||"local"}`} style={{ width:`${item.uploadPct||0}%` }} /></div>
        </div>
      )}
      {item.blobUrl && open && !item.error && (
        <div style={{ padding:"0 16px 10px" }}>
          {isVideo ? <video controls src={item.blobUrl} style={{ width:"100%",maxHeight:180,borderRadius:2,background:"#000" }} /> : <audio controls src={item.blobUrl} style={{ width:"100%",accentColor:cat.color,height:36 }} />}
        </div>
      )}
      {item.blobUrl && !item.error && open && (
        <div style={{ padding:"0 16px 16px", display:"flex", flexDirection:"column", gap:10 }}>
          <ThumbnailPicker value={item.meta?.thumbnailUrl} onChange={(url,name,file)=>{onMetaChange(idx,"thumbnailUrl",url);onMetaChange(idx,"thumbnailName",name);onMetaChange(idx,"thumbnailFile",file);}} />
          <div>
            <label className="mn" style={{ fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:5,textTransform:"uppercase" }}>{isSong?"Song Title *":"Episode Title *"}</label>
            <input className="field" style={{fontSize:12}} value={item.meta?.title||""} placeholder={isSong?"e.g. Summer Vibes":"e.g. The Future of AI"} onChange={e=>onMetaChange(idx,"title",e.target.value)} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <div>
              <label className="mn" style={{ fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:5,textTransform:"uppercase" }}>{isSong?"Artist / Band":"Host / Guest"}</label>
              <input className="field" style={{fontSize:12}} value={item.meta?.guest||""} placeholder={isSong?"Artist name":"Your name"} onChange={e=>onMetaChange(idx,"guest",e.target.value)} />
            </div>
            <div>
              <label className="mn" style={{ fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:5,textTransform:"uppercase" }}>{isSong?"Album / EP":"Episode No."}</label>
              <input className="field" style={{fontSize:12}} value={item.meta?.epNum||""} placeholder={isSong?"Album":"E049"} onChange={e=>onMetaChange(idx,"epNum",e.target.value)} />
            </div>
          </div>
          {isVideo && (
            <div>
              <label className="mn" style={{ fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:5,textTransform:"uppercase" }}>Video Quality</label>
              <select className="field" style={{fontSize:12,color:"var(--c)"}} value={item.meta?.quality||""} onChange={e=>onMetaChange(idx,"quality",e.target.value)}>
                <option value="" style={{background:"#131313"}}>Select quality…</option>
                {["4K (2160p)","Full HD (1080p)","HD (720p)","SD (480p)","360p"].map(q=><option key={q} style={{background:"#131313"}}>{q}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="mn" style={{ fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:5,textTransform:"uppercase" }}>Tags <span style={{fontWeight:400,opacity:.6}}>(comma-separated)</span></label>
            <input className="field" style={{fontSize:12}} value={item.meta?.tags||""} placeholder={isSong?"Pop, Electronic":"Technology, AI"} onChange={e=>onMetaChange(idx,"tags",e.target.value)} />
          </div>
          <div>
            <label className="mn" style={{ fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:5,textTransform:"uppercase" }}>Description</label>
            <textarea className="field" style={{fontSize:12,resize:"vertical",minHeight:70}} value={item.meta?.desc||""} placeholder={isSong?"About this track…":"Brief summary of the episode..."} onChange={e=>onMetaChange(idx,"desc",e.target.value)} />
          </div>
          {/* ── Podcast Category Picker ─── */}
          <div>
            <label className="mn" style={{ fontSize:8,color:"var(--a)",letterSpacing:".1em",display:"block",marginBottom:8,textTransform:"uppercase" }}>📂 Podcast Category <span style={{color:"var(--r)",fontWeight:700}}>*</span></label>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:6}}>
              {PODCAST_CATEGORIES.filter(c=>c.id!=="all").map(c=>{
                const selected=(item.meta?.podcastCategory||"other")===c.id;
                return (
                  <button key={c.id} type="button" onClick={()=>onMetaChange(idx,"podcastCategory",c.id)}
                    style={{display:"flex",alignItems:"center",gap:6,padding:"7px 10px",border:`1px solid ${selected?c.border:"var(--bdr)"}`,borderRadius:3,background:selected?c.accent:"rgba(255,255,255,.02)",cursor:"pointer",transition:"all .2s",outline:"none"}}
                    onMouseEnter={e=>{if(!selected)e.currentTarget.style.borderColor=c.border;}}
                    onMouseLeave={e=>{if(!selected)e.currentTarget.style.borderColor="var(--bdr)";}}>
                    <span style={{fontSize:13,flexShrink:0}}>{c.icon}</span>
                    <span style={{fontSize:9,fontFamily:"'JetBrains Mono'",color:selected?c.color:"var(--g)",letterSpacing:".04em",fontWeight:selected?700:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.label}</span>
                    {selected&&<span style={{marginLeft:"auto",fontSize:10,color:c.color,flexShrink:0}}>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   PAGE COMPONENTS & MAIN APP
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   NAVBAR
   ═══════════════════════════════════════════════════════════════ */
function NavbarV2({ page, nav, onSearch, darkMode, toggleDark, serverOnline }) {
  const y = useScrollY();
  const [open, setOpen] = useState(false);
  const scrolled = y > 50;
  const desktopLinks = [
    {id:"home",l:"Home"},{id:"episodes",l:"Episodes"},{id:"guests",l:"Guests"},
    {id:"about",l:"About"},{id:"subscribe",l:"Subscribe"},{id:"contact",l:"Contact"},{id:"upload",l:"Upload"},
  ];
  const mobileLinks = [
    {id:"home",l:"Home"},{id:"episodes",l:"Episodes"},{id:"guests",l:"Guests"},
    {id:"about",l:"About"},{id:"subscribe",l:"Subscribe"},{id:"contact",l:"Contact"},{id:"upload",l:"Upload"},
  ];
  return (
    <nav style={{ position:"fixed",top:0,left:0,right:0,zIndex:1000, background:darkMode?(scrolled?"rgba(7,7,7,.96)":"transparent"):(scrolled?"rgba(245,243,239,.96)":"transparent"), backdropFilter:scrolled?"blur(20px)":"none", borderBottom:scrolled?"1px solid var(--bdr)":"1px solid transparent", transition:"all .4s ease" }}>
      <div className="wrap" style={{ display:"flex",alignItems:"center",justifyContent:"space-between",height:68,gap:16,minWidth:0 }}>
        <button onClick={()=>nav("home")} style={{ background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:11,padding:0,flexShrink:0,minWidth:0,maxWidth:"clamp(120px,30vw,200px)",overflow:"hidden" }}>
          <WaveBars count={6} height={18} />
          <div style={{minWidth:0,overflow:"hidden"}}>
            <div className="bb" style={{ fontSize:"clamp(13px,2.5vw,19px)",color:"var(--c)",letterSpacing:".06em",lineHeight:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>Signal & Noise</div>
            <div className="mn" style={{ fontSize:"clamp(7px,1.5vw,8px)",color:"var(--g)",letterSpacing:".16em" }}>THE PODCAST</div>
          </div>
        </button>
        <div className="hm" style={{ display:"flex",gap:"clamp(12px,2.5vw,28px)",alignItems:"center",flex:1,justifyContent:"center",minWidth:0 }}>
          {desktopLinks.map(l=><button key={l.id} className={`nl${page===l.id?" act":""}`} onClick={()=>nav(l.id)}>{l.l}</button>)}
        </div>
        <div style={{ display:"flex",gap:"clamp(6px,2vw,8px)",alignItems:"center",flexShrink:0 }}>
          <div className="hm"><ServerStatusBadge online={serverOnline} /></div>
          <button onClick={onSearch} className="hm" style={{ width:34,height:34,borderRadius:2,background:"rgba(255,255,255,.05)",border:"1px solid var(--bdr)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--g)",fontSize:14,transition:"all .2s" }} onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--a)";e.currentTarget.style.color="var(--a)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.color="var(--g)"}}>⌕</button>
          <button onClick={toggleDark} className="hm" style={{ width:34,height:34,borderRadius:2,background:"rgba(255,255,255,.05)",border:"1px solid var(--bdr)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,transition:"all .2s" }} onMouseEnter={e=>e.currentTarget.style.borderColor="var(--a)"} onMouseLeave={e=>e.currentTarget.style.borderColor="var(--bdr)"}>{darkMode?"☀":"🌙"}</button>
          <button className="btn btn-a hm" onClick={()=>nav("subscribe")} style={{ padding:"9px 20px",fontSize:10,whiteSpace:"nowrap" }}>Subscribe</button>
          <button onClick={()=>setOpen(!open)} style={{ background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",gap:5,padding:4,width:44,height:44,justifyContent:"center",alignItems:"center",flexShrink:0 }}>
            {[0,1,2].map(i=><div key={i} style={{ width:22,height:1.5,background:"var(--c)",transition:"all .3s", transform:open?(i===0?"rotate(45deg) translate(4px,4.5px)":i===2?"rotate(-45deg) translate(4px,-4.5px)":"none"):"none", opacity:open&&i===1?0:1 }} />)}
          </button>
        </div>
      </div>
      <div style={{ maxHeight:open?"400px":0,overflow:"hidden",transition:"max-height .4s ease", background:darkMode?"rgba(7,7,7,.98)":"rgba(245,243,239,.98)", borderTop:open?"1px solid var(--bdr)":"none" }}>
        <div className="wrap" style={{ padding:"18px 16px 24px",display:"flex",flexDirection:"column",gap:2 }}>
          {mobileLinks.map(l=><button key={l.id} onClick={()=>{nav(l.id);setOpen(false);}} className="nl" style={{ textAlign:"left",padding:"11px 0",borderBottom:"1px solid var(--bdr)",fontSize:13 }}>{l.l}</button>)}
          <div style={{ display:"flex",gap:8,marginTop:12 }}>
            <button className="btn btn-a" onClick={()=>{nav("subscribe");setOpen(false);}} style={{ flex:1,padding:12,justifyContent:"center" }}>Subscribe</button>
            <button onClick={()=>{onSearch();setOpen(false);}} className="btn btn-g" style={{ padding:"12px 16px" }}>⌕</button>
          </div>
        </div>
      </div>
    </nav>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SCRUBBER  — drag-aware progress bar (works for both players)
   ═══════════════════════════════════════════════════════════════ */
function Scrubber({ prog, dur, onSeek, disabled, accentColor="var(--a)", height=4 }) {
  const barRef = useRef(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState(false);
  const [localPct, setLocalPct] = useState(null); // override during drag

  const pct = localPct !== null ? localPct : prog;
  const curSec = dur ? (pct / 100) * dur : 0;
  const fmt = s => { if (!s || isNaN(s)) return "0:00"; const m = Math.floor(s/60), sc = Math.floor(s%60); return `${m}:${String(sc).padStart(2,"0")}`; };

  const getPct = e => {
    const bar = barRef.current; if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
  };

  const startDrag = e => {
    if (disabled) return;
    e.preventDefault();
    dragging.current = true;
    const p = getPct(e);
    setLocalPct(p);
    const onMove = ev => { if (!dragging.current) return; setLocalPct(getPct(ev)); };
    const onUp   = ev => {
      if (!dragging.current) return;
      dragging.current = false;
      const final = getPct(ev);
      setLocalPct(null);
      onSeek(final);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend",  onUp);
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend",  onUp);
    };
    window._scrubCleanup = cleanup;
    // auto-cleanup if mouseup fires on window
    window.addEventListener("mouseup", () => { cleanup(); }, { once: true });
  };

  const h = hover || dragging.current ? height * 2.5 : height;

  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, width:"100%" }}>
      <span style={{ fontSize:10, fontFamily:"'JetBrains Mono'", color:"rgba(255,255,255,.45)", flexShrink:0, minWidth:34, textAlign:"right", userSelect:"none" }}>{fmt(curSec)}</span>
      <div
        ref={barRef}
        style={{ flex:1, position:"relative", height:24, display:"flex", alignItems:"center", cursor:disabled?"not-allowed":"pointer" }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { if (!dragging.current) setHover(false); }}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      >
        {/* Track background */}
        <div style={{ position:"absolute", left:0, right:0, height:h, background:"rgba(255,255,255,.15)", borderRadius:h, transition:"height .12s", overflow:"hidden" }}>
          {/* Filled */}
          <div style={{ height:"100%", width:`${pct}%`, background: disabled ? "rgba(255,255,255,.25)" : accentColor, borderRadius:h, transition: dragging.current ? "none" : "width .08s linear" }} />
        </div>
        {/* Thumb */}
        {!disabled && (
          <div style={{ position:"absolute", left:`${pct}%`, top:"50%", width: hover || dragging.current ? 14 : 0, height: hover || dragging.current ? 14 : 0, borderRadius:"50%", background:"#fff", transform:"translate(-50%,-50%)", boxShadow:`0 0 6px ${accentColor}`, transition:"width .12s, height .12s", flexShrink:0, pointerEvents:"none", zIndex:2 }} />
        )}
      </div>
      <span style={{ fontSize:10, fontFamily:"'JetBrains Mono'", color:"rgba(255,255,255,.3)", flexShrink:0, minWidth:34, userSelect:"none" }}>{fmt(dur)||"—:——"}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   AUDIO PLAYER BAR  — Spotify style
   ═══════════════════════════════════════════════════════════════ */
function PlayerBar({ ep, onClose }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [prog,    setProg]    = useState(0);
  const [dur,     setDur]     = useState(0);
  const [vol,     setVol]     = useState(80);
  const [muted,   setMuted]   = useState(false);
  const [speed,   setSpeed]   = useState(1);
  const [noAudio, setNoAudio] = useState(false);
  const [liked,   setLiked]   = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  const isSong = ep.mediaType === "song";
  const accentColor = isSong ? "#1db954" : "var(--a)";

  /* ── load audio on ep change ─── */
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const src = ep.audioUrl || ep.cloudAudioUrl || null;
    if (!src) { setNoAudio(true); setPlaying(false); return; }
    setNoAudio(false); setProg(0); setDur(0);
    a.src = src; a.playbackRate = speed; a.volume = muted ? 0 : vol / 100;
    a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    const onTU  = () => { if (a.duration) setProg((a.currentTime / a.duration) * 100); };
    const onLM  = () => setDur(a.duration || 0);
    const onEnd = () => setPlaying(false);
    a.addEventListener("timeupdate",    onTU);
    a.addEventListener("loadedmetadata",onLM);
    a.addEventListener("ended",         onEnd);
    return () => { a.pause(); a.removeEventListener("timeupdate",onTU); a.removeEventListener("loadedmetadata",onLM); a.removeEventListener("ended",onEnd); };
  }, [ep]);

  useEffect(() => { const a = audioRef.current; if (!a || noAudio) return; playing ? a.play().catch(() => {}) : a.pause(); }, [playing]);
  useEffect(() => { const a = audioRef.current; if (!a) return; a.volume = muted ? 0 : vol / 100; }, [vol, muted]);
  useEffect(() => { const a = audioRef.current; if (!a) return; a.playbackRate = speed; }, [speed]);

  /* ── keyboard shortcuts ─── */
  useEffect(() => {
    const fn = e => {
      const tag = document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); if (!noAudio) setPlaying(p => !p); }
      if (e.key === "ArrowRight") skip(15);
      if (e.key === "ArrowLeft")  skip(-15);
      if (e.key === "m" || e.key === "M") setMuted(m => !m);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [noAudio]);

  const skip = d => {
    const a = audioRef.current;
    if (a && a.duration) a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + d));
  };

  const handleSeek = pct => {
    setProg(pct);
    const a = audioRef.current;
    if (a && a.duration) a.currentTime = (pct / 100) * a.duration;
  };

  const IconBtn = ({ onClick, children, title, size=20, active=false, disabled=false }) => (
    <button onClick={onClick} title={title} disabled={disabled}
      style={{ background:"none", border:"none", cursor: disabled?"not-allowed":"pointer", color: active ? accentColor : "rgba(255,255,255,.55)", fontSize:size, lineHeight:1, padding:"6px 8px", borderRadius:4, transition:"color .15s, transform .12s", display:"flex", alignItems:"center", justifyContent:"center", opacity: disabled ? .3 : 1, flexShrink:0 }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.color = active ? accentColor : "#fff"; e.currentTarget.style.transform = "scale(1.12)"; }}
      onMouseLeave={e => { e.currentTarget.style.color = active ? accentColor : "rgba(255,255,255,.55)"; e.currentTarget.style.transform = "scale(1)"; }}>
      {children}
    </button>
  );

  /* ── SVG icons ─── */
  const IC = {
    prev: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>,
    next: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.94V8.06L8.5 12zM16 6h2v12h-2z"/></svg>,
    play: <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>,
    pause:<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>,
    heart:<svg width="16" height="16" viewBox="0 0 24 24" fill={liked?accentColor:"none"} stroke={liked?accentColor:"currentColor"} strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>,
    volHigh:<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>,
    volLow: <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>,
    volMute:<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>,
    close:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  };

  return (
    <div style={{ position:"fixed", bottom:0, left:0, right:0, zIndex:900, background:"rgba(12,12,12,.97)", backdropFilter:"blur(28px)", borderTop:"1px solid rgba(255,255,255,.07)", animation:"fadeUp .4s cubic-bezier(.16,1,.3,1)", userSelect:"none" }}>
      <audio ref={audioRef} preload="metadata" />

      {/* No audio warning */}
      {noAudio && (
        <div style={{ background:"rgba(245,166,35,.07)", borderBottom:"1px solid rgba(245,166,35,.14)", padding:"7px 20px", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:11, color:"var(--a)", fontFamily:"'JetBrains Mono'", letterSpacing:".05em" }}>⚠ No audio file attached — upload one to enable playback.</span>
        </div>
      )}

      {/* Main bar — mobile-first layout */}
      <div style={{ display:"flex", flexDirection:"column", padding:"8px 12px 10px" }}>

        {/* Scrubber — full width, always on top on mobile */}
        <div style={{ marginBottom:8 }}>
          <Scrubber prog={prog} dur={dur} onSeek={handleSeek} disabled={noAudio} accentColor={accentColor} height={4} />
        </div>

        {/* Controls row */}
        <div style={{ display:"flex", alignItems:"center", gap:0, minHeight:52 }}>

          {/* LEFT — track info */}
          <div style={{ display:"flex", alignItems:"center", gap:10, flex:1, minWidth:0, marginRight:8 }}>
            <div style={{ position:"relative", flexShrink:0 }}>
              <img src={ep.img||ep.cover||FALLBACK_IMG} alt="" style={{ width:44, height:44, objectFit:"cover", borderRadius:4, border:"1px solid rgba(255,255,255,.08)", boxShadow:"0 4px 16px rgba(0,0,0,.5)", display:"block" }} />
              {isSong && <div style={{ position:"absolute", inset:0, borderRadius:4, background:"linear-gradient(135deg,rgba(29,185,84,.2),transparent)" }} />}
            </div>
            <div style={{ minWidth:0, flex:1 }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:1 }}>{ep.title}</div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,.45)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{ep.guest||ep.host||"Signal & Noise"}{ep.num?` · ${ep.num}`:""}</div>
            </div>
            <IconBtn onClick={() => setLiked(v => !v)} title={liked?"Unlike":"Like"} active={liked} size={16}>{IC.heart}</IconBtn>
          </div>

          {/* CENTER — playback controls */}
          <div style={{ display:"flex", alignItems:"center", gap:2, flexShrink:0 }}>
            <IconBtn onClick={() => skip(-15)} title="Back 15s" disabled={noAudio} size={18}>{IC.prev}</IconBtn>
            <button onClick={() => !noAudio && setPlaying(p => !p)}
              style={{ width:40, height:40, borderRadius:"50%", background: noAudio ? "rgba(255,255,255,.1)" : "#fff", border:"none", cursor: noAudio ? "not-allowed" : "pointer", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color: noAudio ? "rgba(255,255,255,.3)" : "#000", flexShrink:0, transition:"transform .12s, background .2s", boxShadow: noAudio ? "none" : "0 0 20px rgba(255,255,255,.15)" }}
              onMouseEnter={e => { if (!noAudio) e.currentTarget.style.transform = "scale(1.08)"; }}
              onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
              {playing ? IC.pause : IC.play}
            </button>
            <IconBtn onClick={() => skip(15)} title="Forward 15s" disabled={noAudio} size={18}>{IC.next}</IconBtn>
          </div>

          {/* RIGHT — speed + volume + close (desktop-enhanced) */}
          <div style={{ display:"flex", alignItems:"center", gap:4, marginLeft:8, flexShrink:0 }}>
            {/* Speed picker */}
            <div style={{ position:"relative" }}>
              <button onClick={() => setShowSpeed(v => !v)}
                style={{ background: showSpeed ? "rgba(255,255,255,.1)" : "none", border:"1px solid " + (showSpeed?"rgba(255,255,255,.2)":"transparent"), borderRadius:4, cursor:"pointer", color: speed!==1 ? accentColor : "rgba(255,255,255,.5)", fontFamily:"'JetBrains Mono'", fontSize:9, letterSpacing:".05em", padding:"4px 7px", transition:"all .15s", whiteSpace:"nowrap", minHeight:32 }}>
                {speed}×
              </button>
              {showSpeed && (
                <div style={{ position:"absolute", bottom:"calc(100% + 8px)", right:0, left:"auto", background:"#282828", border:"1px solid rgba(255,255,255,.1)", borderRadius:6, padding:6, display:"flex", flexDirection:"column", gap:2, zIndex:10, boxShadow:"0 8px 24px rgba(0,0,0,.6)", minWidth:70, maxWidth:"90vw" }}>
                  {[0.5,0.75,1,1.25,1.5,2].map(s => (
                    <button key={s} onClick={() => { setSpeed(s); setShowSpeed(false); }}
                      style={{ padding:"8px 12px", background: speed===s ? "rgba(255,255,255,.12)" : "transparent", border:"none", borderRadius:4, color: speed===s ? "#fff" : "rgba(255,255,255,.6)", fontFamily:"'JetBrains Mono'", fontSize:11, cursor:"pointer", textAlign:"left", transition:"background .15s" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.08)"}
                      onMouseLeave={e => e.currentTarget.style.background = speed===s ? "rgba(255,255,255,.12)" : "transparent"}>
                      {s}× {speed===s && "✓"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Volume — hidden on small screens */}
            <div className="hm" style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
              <IconBtn onClick={() => setMuted(m => !m)} title="Mute (M)" size={16}>
                {muted || vol === 0 ? IC.volMute : vol > 50 ? IC.volHigh : IC.volLow}
              </IconBtn>
              <div style={{ width:72, position:"relative", height:20, display:"flex", alignItems:"center" }}>
                <div style={{ position:"absolute", left:0, right:0, height:4, background:"rgba(255,255,255,.15)", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${muted?0:vol}%`, background:accentColor, borderRadius:2, transition:"width .08s" }} />
                </div>
                <input type="range" min="0" max="100" value={muted?0:vol}
                  onChange={e => { setVol(+e.target.value); setMuted(false); }}
                  style={{ position:"absolute", left:0, right:0, width:"100%", opacity:0, cursor:"pointer", height:20, margin:0, padding:0 }} />
              </div>
            </div>
            {/* Wave bars — desktop only */}
            <div className="hm"><WaveBars count={10} height={20} playing={playing && !noAudio} color={accentColor} /></div>
            <IconBtn onClick={onClose} title="Close" size={16}>{IC.close}</IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   VIDEO PLAYER MODAL  — YouTube-style
   ═══════════════════════════════════════════════════════════════ */
function VideoPlayerModal({ ep:initialEp, onClose, allEps=[] }) {
  const [ep,setEp]=useState(initialEp);
  const vRef=useRef(null);
  const [playing,setPlaying]=useState(false),[prog,setProg]=useState(0),[dur,setDur]=useState(0);
  const [muted,setMuted]=useState(false),[vol,setVol]=useState(90),[speed,setSpeed]=useState(1);
  const [showCtrl,setShowCtrl]=useState(true),[fullscreen,setFullscreen]=useState(false);
  const [volHover,setVolHover]=useState(false);
  const hideT=useRef(null);
  const videoWrapRef=useRef(null);   // fullscreen target = the video wrapper div

  // Sidebar: uploaded videos first, then demo audio episodes as "More Episodes"
  const uploadedVideos=allEps.filter(e=>e.mediaType==="video"&&String(e.id)!==String(ep.id)&&(e.videoUrl||e.cloudVideoUrl));
  const demoAudioRecs=allEps.filter(e=>!e.isLocal&&String(e.id)!==String(ep.id)).slice(0,6);

  // Switch to another video
  const switchEp=rec=>{
    const v=vRef.current; if(v){v.pause();v.src="";}
    setProg(0);setDur(0);setPlaying(false);setEp(rec);
  };

  useEffect(()=>{
    document.body.style.overflow="hidden";
    return()=>{document.body.style.overflow="";};
  },[]);

  useEffect(()=>{
    const v=vRef.current; if(!v) return;
    const src=ep.videoUrl||ep.cloudVideoUrl||null; if(!src) return;
    v.src=src; v.volume=muted?0:vol/100;
    v.play().then(()=>setPlaying(true)).catch(()=>setPlaying(false));
    const onTU=()=>{if(v.duration)setProg((v.currentTime/v.duration)*100)};
    const onLM=()=>setDur(v.duration||0), onEnd=()=>setPlaying(false);
    v.addEventListener("timeupdate",onTU); v.addEventListener("loadedmetadata",onLM); v.addEventListener("ended",onEnd);
    return ()=>{v.pause();v.removeEventListener("timeupdate",onTU);v.removeEventListener("loadedmetadata",onLM);v.removeEventListener("ended",onEnd);};
  },[ep]);
  useEffect(()=>{const v=vRef.current;if(!v)return;playing?v.play().catch(()=>{}):v.pause();},[playing]);
  useEffect(()=>{const v=vRef.current;if(!v)return;v.volume=muted?0:vol/100;},[vol,muted]);
  useEffect(()=>{const v=vRef.current;if(!v)return;v.playbackRate=speed;},[speed]);

  // Keyboard shortcuts
  useEffect(()=>{
    const fn=e=>{
      if(e.key==="Escape"){if(document.fullscreenElement){document.exitFullscreen?.();}else{onClose();}return;}
      if(e.key===" "){e.preventDefault();setPlaying(p=>!p);}
      if(e.key==="ArrowRight"){const v=vRef.current;if(v)v.currentTime=Math.min(v.duration||0,v.currentTime+10);}
      if(e.key==="ArrowLeft"){const v=vRef.current;if(v)v.currentTime=Math.max(0,v.currentTime-10);}
      if(e.key==="ArrowUp"){setVol(v=>Math.min(100,v+10));setMuted(false);}
      if(e.key==="ArrowDown"){setVol(v=>Math.max(0,v-10));}
      if(e.key==="m"||e.key==="M"){setMuted(m=>!m);}
      if(e.key==="f"||e.key==="F"){toggleFS();}
    };
    window.addEventListener("keydown",fn);return()=>window.removeEventListener("keydown",fn);
  },[]);

  // Track fullscreen state changes (e.g. user pressed Esc in native FS)
  useEffect(()=>{
    const fn=()=>setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange",fn);
    return()=>document.removeEventListener("fullscreenchange",fn);
  },[]);

  const fmt=s=>{if(!s||isNaN(s))return"0:00";const m=Math.floor(s/60),sc=Math.floor(s%60);return`${m}:${String(sc).padStart(2,"0")}`};
  const clickProg=e=>{const r=e.currentTarget.getBoundingClientRect(),pct=((e.clientX-r.left)/r.width)*100;setProg(pct);const v=vRef.current;if(v&&v.duration)v.currentTime=(pct/100)*v.duration;};
  const skip=d=>{const v=vRef.current;if(v&&v.duration)v.currentTime=Math.max(0,Math.min(v.duration,v.currentTime+d));};
  const onMM=()=>{setShowCtrl(true);clearTimeout(hideT.current);hideT.current=setTimeout(()=>{if(playing)setShowCtrl(false);},3000);};
  const curSec=dur?(prog/100)*dur:0;

  // Fullscreen: target the video wrapper div so controls stay inside it
  const toggleFS=()=>{
    if(!document.fullscreenElement){
      videoWrapRef.current?.requestFullscreen?.().then(()=>setFullscreen(true)).catch(()=>{});
    } else {
      document.exitFullscreen?.();
    }
  };

  return (
    <div style={{ position:"fixed",inset:0,zIndex:2500,background:"#070707",display:"flex",flexDirection:"column",animation:"fadeIn .2s ease",overflow:"hidden" }}>
      {/* Top bar */}
      <div style={{ display:"flex",alignItems:"center",gap:14,padding:"10px 18px",borderBottom:"1px solid rgba(255,255,255,.07)",background:"#0a0a0a",flexShrink:0 }}>
        <button onClick={onClose} style={{ width:34,height:34,borderRadius:4,background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.1)",cursor:"pointer",color:"#fff",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",transition:"background .2s",flexShrink:0 }} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,.18)"} onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,.08)"}> ← </button>
        <div style={{ flex:1,minWidth:0 }}>
          <div className="mn" style={{ fontSize:8,color:"rgba(139,92,246,.9)",letterSpacing:".12em",marginBottom:1 }}>🎬 NOW PLAYING</div>
          <div style={{ fontSize:14,fontWeight:600,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ep.title}</div>
        </div>
        <WaveBars count={8} height={20} playing={playing} color="#8b5cf6" />
      </div>

      {/* Main content: video + sidebar — flex column on mobile, row on desktop */}
      <div style={{ display:"flex",flex:1,overflow:"hidden",minHeight:0 }}
        className="vid-modal-body">

        {/* Video column */}
        <div className="vid-video-col">

          {/* ── Video wrapper — this is what goes fullscreen ── */}
          <div
            ref={videoWrapRef}
            style={{ position:"relative",width:"100%",flex:1,background:"#000",cursor:"pointer",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center" }}
            onMouseMove={onMM}
            onMouseLeave={()=>{if(playing)setShowCtrl(false);}}
            onTouchStart={()=>{setShowCtrl(true);clearTimeout(hideT.current);hideT.current=setTimeout(()=>{if(playing)setShowCtrl(false);},3500);}}
          >
            <video
              ref={vRef}
              style={{ width:"100%",height:"100%",objectFit:"contain",display:"block",background:"#000" }}
              onClick={()=>setPlaying(p=>!p)}
              onDoubleClick={toggleFS}
              playsInline
            />

            {/* Big play overlay */}
            {!playing && (
              <div onClick={()=>setPlaying(true)} style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",background:"rgba(0,0,0,.25)" }}>
                <div style={{ width:80,height:80,borderRadius:"50%",background:"rgba(139,92,246,.92)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,color:"#fff",boxShadow:"0 0 50px rgba(139,92,246,.5)",transition:"transform .2s" }}
                  onMouseEnter={e=>e.currentTarget.style.transform="scale(1.12)"}
                  onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>▶</div>
              </div>
            )}

            {/* Controls overlay — stays inside fullscreen container */}
            <div style={{ position:"absolute",bottom:0,left:0,right:0,zIndex:10,background:"linear-gradient(to top,rgba(0,0,0,.95) 0%,rgba(0,0,0,.5) 60%,transparent 100%)",padding:"40px 14px 10px",transition:"opacity .35s",opacity:showCtrl?1:0,pointerEvents:showCtrl?"auto":"none" }}>

              {/* Scrubber — wider touch target */}
              <div style={{ position:"relative",height:5,background:"rgba(255,255,255,.22)",borderRadius:3,cursor:"pointer",marginBottom:10,transition:"height .15s" }}
                onClick={clickProg}
                onTouchStart={e=>{e.preventDefault();const r=e.currentTarget.getBoundingClientRect(),pct=((e.touches[0].clientX-r.left)/r.width)*100;setProg(Math.max(0,Math.min(100,pct)));const v=vRef.current;if(v&&v.duration)v.currentTime=(Math.max(0,Math.min(100,pct))/100)*v.duration;}}
                onMouseEnter={e=>e.currentTarget.style.height="8px"}
                onMouseLeave={e=>e.currentTarget.style.height="5px"}>
                <div style={{ height:"100%",width:`${prog}%`,background:"#8b5cf6",borderRadius:3 }} />
                <div style={{ position:"absolute",top:"50%",left:`${prog}%`,width:16,height:16,borderRadius:"50%",background:"#a78bfa",transform:"translate(-50%,-50%)",boxShadow:"0 0 8px rgba(139,92,246,.9)" }} />
              </div>

              {/* Controls row */}
              <div className="vid-ctrl-row" style={{ padding:"2px 0" }}>
                {/* Skip back */}
                <button onClick={()=>skip(-10)} title="Back 10s" style={{ background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,.75)",fontSize:20,lineHeight:1,padding:"4px 6px",transition:"color .15s",minHeight:44,minWidth:36,display:"flex",alignItems:"center",justifyContent:"center" }} onMouseEnter={e=>e.currentTarget.style.color="#fff"} onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,.75)"}>⏮</button>
                {/* Play/Pause */}
                <button onClick={()=>setPlaying(p=>!p)} style={{ width:46,height:46,borderRadius:"50%",background:"#8b5cf6",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:"#fff",flexShrink:0,transition:"transform .15s,background .2s",minWidth:46 }}
                  onMouseEnter={e=>e.currentTarget.style.transform="scale(1.1)"}
                  onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>{playing?"⏸":"▶"}</button>
                {/* Skip forward */}
                <button onClick={()=>skip(10)} title="Forward 10s" style={{ background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,.75)",fontSize:20,lineHeight:1,padding:"4px 6px",transition:"color .15s",minHeight:44,minWidth:36,display:"flex",alignItems:"center",justifyContent:"center" }} onMouseEnter={e=>e.currentTarget.style.color="#fff"} onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,.75)"}>⏭</button>
                {/* Time */}
                <span className="mn vid-time" style={{ fontSize:11,color:"rgba(255,255,255,.7)",flexShrink:0,userSelect:"none",whiteSpace:"nowrap" }}>{fmt(curSec)} / {fmt(dur)||ep.dur}</span>

                <div style={{flex:1}} />

                {/* Speed */}
                <div className="vid-speed-pills" style={{display:"flex",gap:3,flexShrink:0}}>
                  {[0.5,1,1.5,2].map(s=><button key={s} onClick={()=>setSpeed(s)} style={{ padding:"5px 8px",border:`1px solid ${speed===s?"#8b5cf6":"rgba(255,255,255,.15)"}`,background:speed===s?"rgba(139,92,246,.3)":"transparent",color:speed===s?"#c4b5fd":"rgba(255,255,255,.5)",fontFamily:"'JetBrains Mono'",fontSize:9,cursor:"pointer",borderRadius:3,transition:"all .15s",minHeight:36 }}>{s}x</button>)}
                </div>

                {/* Volume — always visible on mobile as tap-to-toggle mute */}
                <div className="vid-vol-wrap" style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}
                  onMouseEnter={()=>setVolHover(true)} onMouseLeave={()=>setVolHover(false)}>
                  <button onClick={()=>setMuted(m=>!m)} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,lineHeight:1,color:"rgba(255,255,255,.8)",transition:"color .15s",minHeight:44,minWidth:36,display:"flex",alignItems:"center",justifyContent:"center"}} onMouseEnter={e=>e.currentTarget.style.color="#fff"} onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,.8)"}>{muted||vol===0?"🔇":vol>50?"🔊":"🔉"}</button>
                  <div style={{width:volHover?68:0,overflow:"hidden",transition:"width .25s",opacity:volHover?1:0}}>
                    <input type="range" min="0" max="100" value={muted?0:vol} onChange={e=>{setVol(+e.target.value);setMuted(false);}} style={{width:68,accentColor:"#8b5cf6",cursor:"pointer",display:"block"}} />
                  </div>
                </div>

                {/* Mute button only on very small screens */}
                <button className="vid-mute-sm" onClick={()=>setMuted(m=>!m)} style={{display:"none",background:"none",border:"none",cursor:"pointer",fontSize:18,lineHeight:1,color:"rgba(255,255,255,.8)",minHeight:44,minWidth:36,alignItems:"center",justifyContent:"center"}}>{muted||vol===0?"🔇":vol>50?"🔊":"🔉"}</button>

                {/* Fullscreen button */}
                <button onClick={toggleFS} title={fullscreen?"Exit Fullscreen (F)":"Fullscreen (F)"}
                  style={{ background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,.8)",fontSize:18,lineHeight:1,padding:"4px 6px",transition:"color .15s",flexShrink:0,minHeight:44,minWidth:36,display:"flex",alignItems:"center",justifyContent:"center" }}
                  onMouseEnter={e=>e.currentTarget.style.color="#fff"}
                  onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,.8)"}>
                  {fullscreen?(
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                  ):(
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Episode info below video — compact on mobile */}
          <div style={{ padding:"10px 14px",background:"#0d0d0d",borderTop:"1px solid rgba(255,255,255,.06)",flexShrink:0 }}>
            <div style={{ display:"flex",alignItems:"flex-start",gap:10 }}>
              <img src={ep.img||ep.cover||FALLBACK_IMG} alt="" style={{ width:40,height:40,borderRadius:3,objectFit:"cover",flexShrink:0,border:"2px solid rgba(139,92,246,.35)" }} />
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:2,flexWrap:"wrap" }}>
                  <div className="mn" style={{ fontSize:8,color:"rgba(139,92,246,.8)",letterSpacing:".12em" }}>{ep.num||"UPLOAD"} · {ep.date||"Uploaded"}</div>
                  {ep._storageMode && <StorageBadge mode={ep._storageMode} />}
                </div>
                <div style={{ fontSize:14,fontWeight:700,color:"#fff",marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ep.title}</div>
                <div style={{ fontSize:11,color:"rgba(255,255,255,.45)" }}>{ep.guest||ep.host}{ep.role?` · ${ep.role}`:""}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar — scrollable list of other videos */}
        <div className="vid-sidebar" style={{ borderTop:"1px solid rgba(255,255,255,.06)" }}>
          <div style={{ padding:"14px 16px",borderBottom:"1px solid rgba(255,255,255,.07)",flexShrink:0 }}>
            <div className="mn" style={{ fontSize:8,color:"rgba(139,92,246,.7)",letterSpacing:".14em",marginBottom:4 }}>// UP_NEXT</div>
            <div style={{ fontSize:13,fontWeight:600,color:"#fff" }}>{uploadedVideos.length>0?"Your Videos":"More Episodes"} <span style={{fontSize:11,color:"rgba(255,255,255,.3)",fontWeight:400}}>({uploadedVideos.length>0?uploadedVideos.length:demoAudioRecs.length})</span></div>
          </div>
          <div style={{ flex:1,padding:"10px 12px",display:"flex",flexDirection:"column",gap:8 }}>
            {uploadedVideos.length===0&&demoAudioRecs.length===0?(
              <div style={{textAlign:"center",padding:"48px 16px"}}>
                <div style={{fontSize:40,marginBottom:12,opacity:.35}}>🎬</div>
                <div className="mn" style={{fontSize:10,color:"rgba(255,255,255,.3)",letterSpacing:".08em",marginBottom:16}}>No other videos yet</div>
                <div style={{fontSize:11,color:"rgba(255,255,255,.2)",lineHeight:1.7}}>Upload more videos to see them here</div>
              </div>
            ):(uploadedVideos.length>0?uploadedVideos:demoAudioRecs).map((rec)=>(
              <div key={rec.id}
                onClick={()=>switchEp(rec)}
                style={{ display:"flex",gap:10,padding:8,borderRadius:4,cursor:"pointer",background:String(rec.id)===String(ep.id)?"rgba(139,92,246,.15)":"rgba(255,255,255,.02)",border:`1px solid ${String(rec.id)===String(ep.id)?"rgba(139,92,246,.4)":"rgba(255,255,255,.05)"}`,transition:"all .2s" }}
                onMouseEnter={e=>{e.currentTarget.style.background="rgba(139,92,246,.12)";e.currentTarget.style.borderColor="rgba(139,92,246,.3)";}}
                onMouseLeave={e=>{e.currentTarget.style.background=String(rec.id)===String(ep.id)?"rgba(139,92,246,.15)":"rgba(255,255,255,.02)";e.currentTarget.style.borderColor=String(rec.id)===String(ep.id)?"rgba(139,92,246,.4)":"rgba(255,255,255,.05)";}}>
                {/* Thumbnail */}
                <div className="thumb-wrap">
                  <img src={rec.img||rec.cover||FALLBACK_IMG} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }} />
                  <div className="thumb-overlay">
                    <div style={{width:32,height:32,borderRadius:"50%",background:"rgba(139,92,246,.9)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#fff"}}>▶</div>
                  </div>
                  {rec.dur&&<div style={{ position:"absolute",bottom:4,right:4,background:"rgba(0,0,0,.82)",borderRadius:2,padding:"1px 6px",fontSize:9,color:"#fff",fontFamily:"'JetBrains Mono'" }}>{rec.dur}</div>}
                  {rec._storageMode&&<div style={{ position:"absolute",top:3,left:3 }}><StorageBadge mode={rec._storageMode} /></div>}
                </div>
                {/* Info */}
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:11,fontWeight:600,color:"rgba(255,255,255,.88)",lineHeight:1.4,marginBottom:5,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical" }}>{rec.title}</div>
                  <div style={{ fontSize:10,color:"rgba(255,255,255,.38)",marginBottom:4 }}>{rec.guest||rec.host||"Uploaded"}</div>
                  <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
                    <div className="mn" style={{ fontSize:8,color:"rgba(74,222,128,.65)",letterSpacing:".06em" }}>✓ Uploaded</div>
                    {rec.date&&<div className="mn" style={{fontSize:8,color:"rgba(255,255,255,.2)"}}>{rec.date}</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   UPLOAD PAGE
   ═══════════════════════════════════════════════════════════════ */
function Upload({ onEpisodeAdded, uploadedEps, onDeleteEpisode, serverOnline }) {
  const [activeTab,setActiveTab]=useState("audio");
  const [queues,setQueues]=useState({audio:[],video:[],song:[]});
  const [dragOver,setDragOver]=useState(false);
  const [submitting,setSubmitting]=useState(false);
  const [globalError,setGlobalError]=useState(null);
  const [successCount,setSuccessCount]=useState(0);
  const fileInputRef=useRef(null);

  const cat=UPLOAD_CATEGORIES[activeTab], queue=queues[activeTab];

  useEffect(()=>()=>{
    Object.values(queues).forEach(q=>q.forEach(item=>{
      if(item.blobUrl)URL.revokeObjectURL(item.blobUrl);
      if(item.meta?.thumbnailUrl?.startsWith("blob:"))URL.revokeObjectURL(item.meta.thumbnailUrl);
    }));
  },[]);

  const defaultMeta=(f,catId)=>({title:f.name.replace(/\.[^.]+$/,"").replace(/[-_]/g," "),guest:"",epNum:"",tags:"",desc:"",thumbnailUrl:null,thumbnailName:null,thumbnailFile:null,quality:"",podcastCategory:"other",catId});

  const processFiles=async files=>{
    const items=[];
    for(const f of files){
      const err=validateMediaFile(f,activeTab);
      if(err){items.push({file:f,blobUrl:null,error:err,duration:null,meta:defaultMeta(f,activeTab),done:false});continue;}
      const blobUrl=URL.createObjectURL(f);
      const isVideo=activeTab==="video";
      const rawDur=await detectDuration(blobUrl,isVideo);
      const duration=isFinite(rawDur)?`${Math.floor(rawDur/60)}:${String(Math.floor(rawDur%60)).padStart(2,"0")}`:null;
      items.push({file:f,blobUrl,error:null,duration,meta:defaultMeta(f,activeTab),done:false,storageMode:null});
    }
    setQueues(prev=>({...prev,[activeTab]:[...prev[activeTab],...items]}));
  };

  const setItemState=(idx,patch)=>setQueues(prev=>({...prev,[activeTab]:prev[activeTab].map((it,i)=>i===idx?{...it,...patch}:it)}));
  const removeItem=idx=>{
    setQueues(prev=>{
      const item=prev[activeTab][idx];
      if(item?.blobUrl)URL.revokeObjectURL(item.blobUrl);
      if(item?.meta?.thumbnailUrl?.startsWith("blob:"))URL.revokeObjectURL(item.meta.thumbnailUrl);
      return{...prev,[activeTab]:prev[activeTab].filter((_,i)=>i!==idx)};
    });
  };
  const updateMeta=(idx,key,val)=>setQueues(prev=>({...prev,[activeTab]:prev[activeTab].map((item,i)=>i===idx?{...item,meta:{...item.meta,[key]:val}}:item)}));

  const publishAll=async()=>{
    const valid=queue.filter(item=>item.blobUrl&&!item.error&&!item.done);
    if(!valid.length){setGlobalError("No valid files to publish.");return;}
    setSubmitting(true);setGlobalError(null);let count=0;

    for(let i=0;i<queue.length;i++){
      const item=queue[i];
      if(!item.blobUrl||item.error||item.done)continue;
      const{file,blobUrl,duration,meta}=item;
      const title=meta.title?.trim()||file.name.replace(/\.[^.]+$/,"");
      const guest=meta.guest?.trim()||(activeTab==="song"?"Unknown Artist":"Unknown Host");
      const epNum=meta.epNum?.trim()||`E${Date.now()}`;
      const tags=(meta.tags||"").split(",").map(t=>t.trim()).filter(Boolean);
      const desc=meta.desc?.trim()||"Uploaded content.";
      const id=Date.now()+i;

      /* Step 1: Upload media file */
      let cloudAudioUrl=null,cloudVideoUrl=null,_publicFileName=null,storageMode="local";
      if(serverOnline){
        setItemState(i,{uploading:true,uploadPct:0,uploadMode:"cloud"});
        const res=await cloudUploadFile(file,activeTab,pct=>setItemState(i,{uploadPct:pct}));
        if(res){
          cloudAudioUrl=activeTab!=="video"?res.publicUrl:null;
          cloudVideoUrl=activeTab==="video"?res.publicUrl:null;
          _publicFileName=res.fileName; storageMode="cloud";
        }
      }
      /* Always save IDB backup */
      setItemState(i,{uploading:true,uploadPct:storageMode==="cloud"?100:50,uploadMode:"local"});
      await saveFileToIDB(id,file).catch(e=>console.warn("IDB save failed:",e));

      /* Step 2: Upload thumbnail */
      let cloudImgUrl=null,thumbPublicFileName=null;
      const fallbackImg=meta.thumbnailUrl||FALLBACK_IMG;
      if(meta.thumbnailFile){
        const tr=await cloudUploadFile(meta.thumbnailFile,"image",null);
        if(tr){cloudImgUrl=tr.publicUrl;thumbPublicFileName=tr.fileName;}
        await saveThumbToIDB(id,meta.thumbnailFile).catch(()=>{});
      }
      setItemState(i,{uploading:false,uploadPct:100,storageMode});

      /* Step 3: Build episode object */
      const newEp={
        id,num:epNum,title,guest,host:guest,
        role:activeTab==="song"?"Artist":activeTab==="video"?"Video Host":"Podcast Host",
        dur:duration||"—:—",
        date:new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}),
        plays:"0",
        tags:tags.length?tags:[activeTab==="song"?"Song":activeTab==="video"?"Video":"Uploaded"],
        desc,
        podcastCategory:meta.podcastCategory||"other",
        /* Cloud public paths (persist across devices/sessions) */
        cloudAudioUrl,cloudVideoUrl,cloudImgUrl,
        /* Blob URLs for immediate local playback */
        audioUrl:activeTab!=="video"?(cloudAudioUrl||blobUrl):null,
        videoUrl:activeTab==="video"?(cloudVideoUrl||blobUrl):null,
        img:cloudImgUrl||fallbackImg,
        cover:cloudImgUrl||fallbackImg,
        chapters:[],featured:false,isNew:true,isLocal:true,
        fileName:file.name,_publicFileName,thumbPublicFileName,
        fileSize:file.size,mediaType:activeTab,quality:meta.quality||null,
        hasThumbnail:!!meta.thumbnailUrl,_hasThumbBlob:!!meta.thumbnailFile,
        _storageMode:storageMode,
      };

      /* Step 4: Persist metadata everywhere */
      /* Always save to Firestore so ALL visitors can see the episode */
      await cloudSaveEpisodeMeta(newEp);
      onEpisodeAdded(newEp);
      setItemState(i,{done:true,storageMode});
      count++;
      await new Promise(r=>setTimeout(r,80));
    }
    setSuccessCount(count);setSubmitting(false);
  };

  const [view,setView]=useState("upload"); // "upload" | "library"
  const [libFilter,setLibFilter]=useState("all"); // "all"|"audio"|"video"|"song"
  const [libSearch,setLibSearch]=useState("");

  const clearDone=()=>setQueues(prev=>({...prev,[activeTab]:prev[activeTab].filter(item=>!item.done)}));
  const clearAll=()=>{queue.forEach(item=>{if(item.blobUrl)URL.revokeObjectURL(item.blobUrl);if(item.meta?.thumbnailUrl?.startsWith("blob:"))URL.revokeObjectURL(item.meta.thumbnailUrl);});setQueues(prev=>({...prev,[activeTab]:[]}));};
  const validCount=queue.filter(item=>item.blobUrl&&!item.error&&!item.done).length;
  const errorCount=queue.filter(item=>item.error).length;
  const doneCount=queue.filter(item=>item.done).length;
  const tabCount=id=>queues[id].length;

  // Library filtered list
  const libEps=(()=>{
    let eps=uploadedEps;
    if(libFilter!=="all")eps=eps.filter(e=>(e.mediaType||"audio")===libFilter);
    if(libSearch.trim()){const q=libSearch.trim().toLowerCase();eps=eps.filter(e=>(e.title||"").toLowerCase().includes(q)||(e.guest||"").toLowerCase().includes(q)||(e.fileName||"").toLowerCase().includes(q));}
    return eps;
  })();
  const libCount=(t)=>t==="all"?uploadedEps.length:uploadedEps.filter(e=>(e.mediaType||"audio")===t).length;

  return (
    <div style={{paddingTop:68}}>
      {/* ── Hero ─────────────────────────────────────────── */}
      <section style={{ position:"relative",minHeight:"280px",display:"flex",alignItems:"center",overflow:"hidden",background:"#060606" }}>
        <div style={{ position:"absolute",inset:0,backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 23px,rgba(245,166,35,.025) 23px,rgba(245,166,35,.025) 24px)",pointerEvents:"none" }} />
        <div style={{ position:"absolute",left:0,top:0,bottom:0,width:3,background:"linear-gradient(to bottom,var(--a),var(--r))" }} />
        <div className="wrap" style={{ position:"relative",zIndex:1,padding:"48px 0 32px" }}>
          <Rv>
            <div style={{ display:"flex",alignItems:"center",gap:14,marginBottom:14,flexWrap:"wrap" }}>
              <div className="mn" style={{ fontSize:11,color:"var(--a)",letterSpacing:".1em" }}>// UPLOAD_PORTAL</div>
              <ServerStatusBadge online={serverOnline} />
            </div>
            <h1 className="bb" style={{ fontSize:"clamp(44px,8vw,96px)",color:"var(--c)",lineHeight:.88,marginBottom:16 }}>Upload<br /><em className="sf" style={{color:"var(--a)"}}>Content.</em></h1>
            <p style={{ fontSize:"clamp(13px,2.5vw,15px)",color:"var(--g)",maxWidth:"min(520px,90vw)",fontWeight:300,lineHeight:1.82,marginBottom:0 }}>
              Files upload directly to <strong style={{color:"var(--a)"}}>Cloudinary</strong> for persistent cloud storage. A local IndexedDB copy is kept for offline playback.
            </p>
          </Rv>
        </div>
      </section>

      {/* ── View switcher pill ───────────────────────────── */}
      <div style={{background:"var(--d2)",borderBottom:"1px solid var(--bdr)",position:"sticky",top:"var(--navbar-h)",zIndex:50}}>
        <div className="wrap" style={{padding:"12px var(--container-padding)",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{display:"flex",background:"rgba(255,255,255,.04)",border:"1px solid var(--bdr)",borderRadius:4,padding:3,gap:2}}>
            {[{id:"upload",label:"⬆ Upload New",color:"var(--a)"},{id:"library",label:`📂 My Library${uploadedEps.length>0?` (${uploadedEps.length})`:""}`,color:"#4ade80"}].map(v=>(
              <button key={v.id} onClick={()=>setView(v.id)}
                style={{padding:"8px 18px",borderRadius:3,border:"none",cursor:"pointer",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".08em",fontWeight:700,transition:"all .2s",
                  background:view===v.id?"rgba(255,255,255,.09)":"transparent",
                  color:view===v.id?v.color:"var(--g)",
                  boxShadow:view===v.id?"0 1px 4px rgba(0,0,0,.4)":"none"
                }}>{v.label}</button>
            ))}
          </div>
          {view==="library"&&uploadedEps.length>0&&(
            <div style={{fontSize:11,color:"var(--g)",marginLeft:4}}>
              <span style={{color:"#4ade80",fontWeight:600}}>{uploadedEps.length}</span> file{uploadedEps.length!==1?"s":""} in your library
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════
          VIEW: LIBRARY
         ══════════════════════════════════════════════════ */}
      {view==="library"&&(
        <section style={{background:"var(--d)",minHeight:"60vh",padding:"40px 0 80px"}}>
          <div className="wrap">
            {/* Library header */}
            <Rv>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:16,marginBottom:28}}>
                <div>
                  <div className="mn" style={{fontSize:8,color:"#4ade80",letterSpacing:".14em",marginBottom:8}}>// YOUR_LIBRARY</div>
                  <h2 className="bb" style={{fontSize:"clamp(32px,5vw,56px)",color:"var(--c)",lineHeight:.9,marginBottom:8}}>My <em className="sf" style={{color:"#4ade80"}}>Library</em></h2>
                  <p style={{fontSize:13,color:"var(--g)",fontWeight:300,margin:0}}>
                    {uploadedEps.length===0?"No files uploaded yet.":
                      `${libCount("audio")} audio · ${libCount("video")} video · ${libCount("song")} song${libCount("song")!==1?"s":""}`}
                  </p>
                </div>
                <button onClick={()=>setView("upload")} className="btn btn-g" style={{fontSize:10,padding:"9px 20px",flexShrink:0}}>⬆ Upload New →</button>
              </div>
            </Rv>

            {uploadedEps.length===0?(
              <Rv delay={.1}>
                <div style={{textAlign:"center",padding:"80px 20px",border:"1px dashed rgba(74,222,128,.2)",borderRadius:4,background:"rgba(74,222,128,.03)"}}>
                  <div style={{fontSize:56,marginBottom:16,opacity:.4}}>📂</div>
                  <div className="mn" style={{fontSize:10,color:"var(--g)",letterSpacing:".1em",marginBottom:20}}>No files in your library yet</div>
                  <button onClick={()=>setView("upload")} className="btn btn-a" style={{fontSize:10}}>Upload Your First File →</button>
                </div>
              </Rv>
            ):(
              <>
                {/* Filter tabs + search */}
                <Rv delay={.08}>
                  <div style={{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
                    <div style={{display:"flex",gap:4,background:"rgba(255,255,255,.03)",border:"1px solid var(--bdr)",borderRadius:3,padding:"3px",flexShrink:0}}>
                      {[{id:"all",label:"All",color:"var(--c)"},{id:"audio",label:"🎙 Audio",color:"var(--a)"},{id:"video",label:"🎬 Video",color:"#8b5cf6"},{id:"song",label:"🎵 Songs",color:"#ec4899"}].map(f=>(
                        <button key={f.id} onClick={()=>setLibFilter(f.id)}
                          style={{padding:"6px 14px",borderRadius:2,border:"none",cursor:"pointer",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".07em",transition:"all .18s",
                            background:libFilter===f.id?"rgba(255,255,255,.1)":"transparent",
                            color:libFilter===f.id?f.color:"var(--g)"}}>
                          {f.label}{libCount(f.id)>0?` (${libCount(f.id)})`:""}
                        </button>
                      ))}
                    </div>
                    <input
                      value={libSearch} onChange={e=>setLibSearch(e.target.value)}
                      placeholder="Search by title, guest, filename…"
                      style={{flex:1,minWidth:180,background:"rgba(255,255,255,.04)",border:"1px solid var(--bdr)",borderRadius:3,padding:"8px 14px",color:"var(--c)",fontFamily:"'DM Sans'",fontSize:12,outline:"none"}}
                      onFocus={e=>e.target.style.borderColor="var(--a)"}
                      onBlur={e=>e.target.style.borderColor="var(--bdr)"}
                    />
                    {libSearch&&<button onClick={()=>setLibSearch("")} style={{background:"none",border:"none",cursor:"pointer",color:"var(--g)",fontSize:16,padding:"0 4px"}}>✕</button>}
                  </div>
                </Rv>

                {/* No results */}
                {libEps.length===0&&(
                  <div style={{textAlign:"center",padding:"60px 20px",opacity:.6}}>
                    <div style={{fontSize:36,marginBottom:12}}>◎</div>
                    <div className="mn" style={{fontSize:10,color:"var(--g)",letterSpacing:".1em"}}>No results for "{libSearch}"</div>
                  </div>
                )}

                {/* Card grid */}
                {libEps.length>0&&(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
                    {libEps.map((ep,i)=>{
                      const mType=ep.mediaType||"audio";
                      const mCat=UPLOAD_CATEGORIES[mType]||UPLOAD_CATEGORIES.audio;
                      const playUrl=ep.audioUrl||ep.cloudAudioUrl;
                      return (
                        <Rv key={ep.id} delay={i*.04}>
                          <div className="card" style={{overflow:"hidden",display:"flex",flexDirection:"column",border:"1px solid var(--bdr)",transition:"border-color .2s"}}
                            onMouseEnter={e=>e.currentTarget.style.borderColor=mCat.border}
                            onMouseLeave={e=>e.currentTarget.style.borderColor="var(--bdr)"}>
                            {/* Thumbnail */}
                            <div style={{position:"relative",height:160,overflow:"hidden",background:"#0a0a0a",flexShrink:0}}>
                              <img src={ep.img||ep.cover||FALLBACK_IMG} alt="" style={{width:"100%",height:"100%",objectFit:"cover",opacity:.85}} />
                              <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(7,7,7,.85) 0%,transparent 55%)"}} />
                              {/* Type badge */}
                              <div style={{position:"absolute",top:8,left:8,display:"flex",gap:4,alignItems:"center"}}>
                                <span style={{fontSize:8,fontFamily:"'JetBrains Mono'",padding:"3px 7px",borderRadius:2,background:mCat.accent,color:mCat.color,border:`1px solid ${mCat.border}`,letterSpacing:".07em",fontWeight:700}}>{mCat.icon} {mCat.label.toUpperCase()}</span>
                                <StorageBadge mode={ep._storageMode||"local"} />
                              </div>
                              {ep.dur&&ep.dur!=="—:—"&&<div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,.82)",borderRadius:2,padding:"2px 7px",fontSize:9,color:"#fff",fontFamily:"'JetBrains Mono'"}}>{ep.dur}</div>}
                            </div>
                            {/* Info */}
                            <div style={{padding:"14px 16px",flex:1,display:"flex",flexDirection:"column",gap:6}}>
                              <div style={{fontSize:13,fontWeight:700,color:"var(--c)",lineHeight:1.3,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{ep.title}</div>
                              {ep.guest&&<div style={{fontSize:11,color:"var(--g)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ep.guest}</div>}
                              {/* Tags */}
                              {(ep.tags||[]).length>0&&(
                                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                                  {(ep.tags||[]).slice(0,3).map(t=><span key={t} className="tag" style={{fontSize:8,opacity:.7}}>{t}</span>)}
                                </div>
                              )}
                              {/* Audio player */}
                              {playUrl&&mType!=="video"&&(
                                <audio controls src={playUrl} style={{width:"100%",height:28,marginTop:4,accentColor:mCat.color}} />
                              )}
                              {/* Actions */}
                              <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",marginTop:"auto",paddingTop:8,borderTop:"1px solid var(--bdr)"}}>
                                {onDeleteEpisode&&(
                                  <button onClick={()=>onDeleteEpisode(ep.id)}
                                    style={{padding:"5px 12px",background:"rgba(232,68,26,.08)",border:"1px solid rgba(232,68,26,.2)",borderRadius:2,cursor:"pointer",color:"var(--r)",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".06em",transition:"all .2s"}}
                                    onMouseEnter={e=>e.currentTarget.style.background="rgba(232,68,26,.18)"}
                                    onMouseLeave={e=>e.currentTarget.style.background="rgba(232,68,26,.08)"}>
                                    ✕ Remove
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </Rv>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {/* ══════════════════════════════════════════════════
          VIEW: UPLOAD
         ══════════════════════════════════════════════════ */}
      {view==="upload"&&(
      <section className="sec">
        <div className="wrap">
          <div className="upload-grid">
            <div className="upload-main">
              {/* Category tabs */}
              <Rv>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3,marginBottom:24 }}>
                  {Object.values(UPLOAD_CATEGORIES).map(c=>{
                    const isActive=activeTab===c.id;
                    return (
                      <button key={c.id} onClick={()=>{setActiveTab(c.id);setGlobalError(null);}}
                        style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:8,flexDirection:"column",padding:"18px 12px",borderRadius:3,cursor:"pointer",border:"1px solid",borderColor:isActive?c.border:"var(--bdr)",background:isActive?c.accent:"rgba(255,255,255,.02)",transition:"all .22s",position:"relative",overflow:"hidden" }}>
                        {isActive&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,background:c.color}} />}
                        <span style={{fontSize:26}}>{c.icon}</span>
                        <div>
                          <div style={{fontSize:12,fontWeight:700,color:isActive?c.color:"var(--c)",letterSpacing:".02em"}}>{c.label}</div>
                          <div style={{fontSize:9,color:"var(--g)",marginTop:2}}>{c.desc}</div>
                        </div>
                        {tabCount(c.id)>0&&<div style={{position:"absolute",top:8,right:8,minWidth:18,height:18,borderRadius:9,background:c.color,color:"#070707",fontSize:9,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 4px"}}>{tabCount(c.id)}</div>}
                      </button>
                    );
                  })}
                </div>
              </Rv>

              <Rv>
                <div className="card" style={{overflow:"hidden"}}>
                  <div style={{ borderBottom:"1px solid var(--bdr)",padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap" }}>
                    <div>
                      <div className="mn" style={{fontSize:8,color:cat.color,letterSpacing:".12em",marginBottom:4}}>// {cat.id.toUpperCase()}_DROP_ZONE</div>
                      <h2 style={{fontSize:16,fontWeight:700,color:"var(--c)"}}>{cat.icon} {cat.label}{queue.length>0&&<span style={{marginLeft:10,fontSize:13,color:"var(--g)",fontWeight:400}}>({queue.length})</span>}</h2>
                    </div>
                    {queue.length>0&&(
                      <div style={{display:"flex",gap:8}}>
                        {doneCount>0&&<button onClick={clearDone} style={{padding:"6px 12px",background:"rgba(74,222,128,.08)",border:"1px solid rgba(74,222,128,.2)",borderRadius:2,cursor:"pointer",color:"rgba(74,222,128,.8)",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".07em"}}>Clear Published ({doneCount})</button>}
                        <button onClick={clearAll} style={{padding:"6px 12px",background:"rgba(232,68,26,.07)",border:"1px solid rgba(232,68,26,.2)",borderRadius:2,cursor:"pointer",color:"var(--r)",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".07em"}}>Clear All</button>
                      </div>
                    )}
                  </div>
                  <div style={{padding:"20px"}}>
                    <input type="file" ref={fileInputRef} style={{display:"none"}} accept={cat.accepted} multiple onChange={e=>{const files=Array.from(e.target.files||[]);if(files.length)processFiles(files);e.target.value="";}} />
                    {/* Drop zone */}
                    <div role="button" tabIndex={0}
                      style={{ border:`2px dashed ${dragOver?cat.color:"var(--bdr)"}`,borderRadius:4,padding:"32px 20px",textAlign:"center",cursor:"pointer",background:dragOver?cat.accent:"rgba(255,255,255,.015)",transition:"all .25s",marginBottom:20 }}
                      onClick={()=>fileInputRef.current?.click()}
                      onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();fileInputRef.current?.click();}}}
                      onDragOver={e=>{e.preventDefault();setDragOver(true)}}
                      onDragLeave={e=>{e.preventDefault();setDragOver(false)}}
                      onDrop={e=>{e.preventDefault();setDragOver(false);const files=Array.from(e.dataTransfer.files||[]);if(files.length)processFiles(files);}}>
                      <div style={{fontSize:38,marginBottom:10}}>{cat.icon}</div>
                      <div className="mn" style={{fontSize:11,color:"var(--c)",marginBottom:6,letterSpacing:".06em"}}>{typeof window!=="undefined"&&window.matchMedia("(pointer:coarse)").matches?cat.mobileLabel:cat.dropLabel}</div>
                      <div style={{fontSize:11,color:"rgba(138,134,128,.7)",marginBottom:14}}>{cat.formatsLine}</div>
                      <div style={{display:"inline-flex",gap:10,flexWrap:"wrap",justifyContent:"center"}}>
                        <span style={{padding:"6px 18px",background:cat.color,borderRadius:2,fontSize:10,color:"#070707",fontFamily:"'JetBrains Mono'",fontWeight:700,letterSpacing:".08em"}}>Choose {cat.label} Files</span>
                        <span style={{padding:"6px 14px",background:"rgba(255,255,255,.04)",border:"1px solid var(--bdr)",borderRadius:2,fontSize:10,color:"var(--g)",fontFamily:"'JetBrains Mono'",letterSpacing:".07em"}}>Multi-select OK</span>
                      </div>
                    </div>
                    {/* Storage mode notice */}
                    <div style={{ marginBottom:16,padding:"10px 14px",background:"rgba(96,165,250,.07)",border:"1px solid rgba(96,165,250,.22)",borderRadius:3,display:"flex",alignItems:"center",gap:10 }}>
                      <span style={{fontSize:14,flexShrink:0}}>☁</span>
                      <span style={{fontSize:11,color:"var(--g)",lineHeight:1.6}}>
                        Files upload directly to <strong style={{color:"var(--cloud-c)"}}>Cloudinary</strong> (cloud name: <strong style={{color:"var(--cloud-c)"}}>dz7nfmey1</strong>) and served via global CDN. A local IDB copy is kept for offline playback.
                      </span>
                    </div>
                    {globalError&&<div style={{marginBottom:16,padding:"11px 14px",background:"rgba(232,68,26,.08)",border:"1px solid rgba(232,68,26,.3)",borderRadius:3,fontSize:12,color:"var(--r)",display:"flex",gap:8,alignItems:"flex-start"}}><span>⚠</span><span>{globalError}</span><button onClick={()=>setGlobalError(null)} style={{marginLeft:"auto",background:"none",border:"none",cursor:"pointer",color:"var(--r)",fontSize:14}}>✕</button></div>}
                    {queue.length>0&&(
                      <div style={{marginBottom:20}}>
                        <div className="mn" style={{fontSize:8,color:cat.color,letterSpacing:".12em",marginBottom:12}}>
                          // FILE_QUEUE — {queue.length} file{queue.length!==1?"s":""}
                          {errorCount>0&&<span style={{color:"var(--r)",marginLeft:10}}>{errorCount} error{errorCount!==1?"s":""}</span>}
                          {validCount>0&&<span style={{color:"rgba(74,222,128,.8)",marginLeft:10}}>{validCount} ready</span>}
                        </div>
                        {queue.map((item,i)=><FileRow key={i} item={item} idx={i} onRemove={removeItem} onMetaChange={updateMeta} catId={activeTab} />)}
                      </div>
                    )}
                    {successCount>0&&doneCount>0&&(
                      <div style={{marginBottom:16,padding:"14px 18px",background:"rgba(74,222,128,.06)",border:"1px solid rgba(74,222,128,.22)",borderRadius:3,display:"flex",alignItems:"center",gap:12}}>
                        <span style={{fontSize:22}}>{cat.icon}</span>
                        <div>
                          <div style={{fontSize:13,fontWeight:600,color:"rgba(74,222,128,.9)",marginBottom:2}}>{doneCount} {cat.label} file{doneCount!==1?"s":""} published!</div>
                          <div style={{fontSize:11,color:"var(--g)"}}>Content appears on the Episodes page with real playback. <button onClick={()=>setView("library")} style={{background:"none",border:"none",cursor:"pointer",color:"#4ade80",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".06em",textDecoration:"underline",padding:0}}>View in Library →</button></div>
                        </div>
                      </div>
                    )}
                    {validCount>0&&(
                      <button onClick={publishAll} disabled={submitting}
                        style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"15px",background:submitting?"rgba(245,166,35,.4)":cat.color,color:"#070707",border:"none",borderRadius:2,cursor:submitting?"not-allowed":"pointer",fontFamily:"'DM Sans'",fontWeight:700,fontSize:12,letterSpacing:".06em",textTransform:"uppercase",transition:"all .2s"}}>
                        {submitting?<><span style={{display:"inline-block",animation:"spin .8s linear infinite",fontSize:14}}>◌</span>{serverOnline?"Uploading to cloud…":"Saving locally…"}</>:<>{cat.icon} Publish {validCount} {cat.label} File{validCount!==1?"s":""} →</>}
                      </button>
                    )}
                    {queue.length===0&&<div style={{textAlign:"center",padding:"10px 0",fontSize:11,color:"rgba(138,134,128,.45)",fontFamily:"'JetBrains Mono'",letterSpacing:".06em"}}>No files selected. Use the drop zone above to begin.</div>}
                    {queue.length===0&&uploadedEps.length>0&&(
                      <div style={{marginTop:16,padding:"12px 16px",background:"rgba(74,222,128,.04)",border:"1px solid rgba(74,222,128,.15)",borderRadius:3,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}} onClick={()=>setView("library")}>
                        <div style={{display:"flex",gap:-8}}>
                          {uploadedEps.slice(0,3).map((ep,i)=><img key={ep.id} src={ep.img||FALLBACK_IMG} alt="" style={{width:32,height:32,borderRadius:"50%",objectFit:"cover",border:"2px solid var(--d)",marginLeft:i>0?-8:0,flexShrink:0}} />)}
                        </div>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:600,color:"rgba(74,222,128,.9)"}}>{uploadedEps.length} file{uploadedEps.length!==1?"s":""} in your library</div>
                          <div style={{fontSize:10,color:"var(--g)"}}>Tap to browse, manage, and delete uploads</div>
                        </div>
                        <span style={{color:"#4ade80",fontSize:14}}>→</span>
                      </div>
                    )}
                  </div>
                </div>
              </Rv>

            </div>

            {/* Sidebar */}
            <div className="upload-sidebar">
              <Rv delay={.18}>
                <div style={{ padding:"16px 18px",background:serverOnline?"rgba(96,165,250,.06)":"rgba(245,166,35,.06)",border:`1px solid ${serverOnline?"rgba(96,165,250,.25)":"rgba(245,166,35,.25)"}`,borderRadius:3,marginBottom:16 }}>
                  <div className="mn" style={{fontSize:8,color:serverOnline?"var(--cloud-c)":"var(--a)",letterSpacing:".12em",marginBottom:10}}>// STORAGE_STATUS</div>
                  <div style={{display:"flex",gap:9,alignItems:"flex-start",marginBottom:10}}>
                    <span style={{fontSize:16,flexShrink:0}}>{serverOnline?"☁":"💾"}</span>
                    <div style={{fontSize:12,color:"var(--g)",lineHeight:1.7}}>
                      {serverOnline
                        ?<>Mode: <strong style={{color:"var(--cloud-c)"}}>Cloud + Local</strong><br />Files stored at <code style={{color:"var(--cloud-c)",fontSize:10}}>public/{CATEGORY_FOLDER[activeTab]}/</code> and served as static URLs. IDB copy kept offline.</>
                        :<>Mode: <strong style={{color:"var(--local-c)"}}>Local Only</strong><br />Files stored in <strong style={{color:"var(--local-c)"}}>IndexedDB</strong>. Will sync when server is back online.</>}
                    </div>
                  </div>
                </div>
              </Rv>
              <Rv delay={.22}>
                <div style={{padding:"20px",background:cat.accent,border:`1px solid ${cat.border}`,borderRadius:3,marginBottom:20,transition:"all .3s"}}>
                  <div className="mn" style={{fontSize:8,color:cat.color,letterSpacing:".12em",marginBottom:12}}>// HOW_IT_WORKS</div>
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    {[
                      [cat.icon,`Select ${cat.label} files from your computer.`],
                      ["🖼️","Upload a thumbnail image — JPG, PNG, or WEBP."],
                      [serverOnline?"☁":"💾",serverOnline?`Files saved to public/${CATEGORY_FOLDER[activeTab]}/ on your server.`:"Files saved to IndexedDB for offline playback."],
                      ["⚡","Playable URL generated instantly — no page reload needed."],
                      ["✏️","Edit title, host/artist, tags, and description."],
                      ["▶","Click Publish — content appears on Episodes page immediately."],
                    ].map(([icon,text])=>(
                      <div key={icon+text} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                        <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{icon}</span>
                        <span style={{fontSize:12,color:"var(--g)",lineHeight:1.65}}>{text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Rv>
              <Rv delay={.26}>
                <div style={{padding:"18px",background:"rgba(255,255,255,.025)",border:"1px solid var(--bdr)",borderRadius:3}}>
                  <div className="mn" style={{fontSize:8,color:cat.color,letterSpacing:".12em",marginBottom:12}}>// SUPPORTED_FORMATS</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:7}}>{cat.formats.map(ext=><span key={ext} className="tag" style={{fontSize:9,borderColor:cat.border,color:cat.color,background:cat.accent}}>{ext}</span>)}</div>
                  <div style={{marginTop:14,fontSize:11,color:"rgba(138,134,128,.55)",lineHeight:1.7}}>Max size: <strong style={{color:"var(--g)"}}>{cat.maxMB>=1024?`${cat.maxMB/1024} GB`:`${cat.maxMB} MB`}</strong> per file.</div>
                  <div style={{marginTop:20}}>
                    <div className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",marginBottom:10}}>// ALL_CATEGORIES</div>
                    {Object.values(UPLOAD_CATEGORIES).map(c=>(
                      <div key={c.id} onClick={()=>setActiveTab(c.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:2,marginBottom:4,cursor:"pointer",background:activeTab===c.id?c.accent:"transparent",border:`1px solid ${activeTab===c.id?c.border:"transparent"}`,transition:"all .2s"}} onMouseEnter={e=>{if(activeTab!==c.id)e.currentTarget.style.background="rgba(255,255,255,.04)"}} onMouseLeave={e=>{if(activeTab!==c.id)e.currentTarget.style.background="transparent"}}>
                        <span style={{fontSize:16}}>{c.icon}</span>
                        <div><div style={{fontSize:11,fontWeight:600,color:activeTab===c.id?c.color:"var(--c)"}}>{c.label}</div><div style={{fontSize:9,color:"var(--g)"}}>{c.formats.join(", ")}</div></div>
                        {tabCount(c.id)>0&&<span style={{marginLeft:"auto",fontSize:10,fontFamily:"'JetBrains Mono'",color:c.color}}>{tabCount(c.id)} queued</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </Rv>
            </div>
          </div>
        </div>
      </section>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SEARCH OVERLAY
   ═══════════════════════════════════════════════════════════════ */
function SearchOverlay({ onClose, nav, onPlay, uploadedEps=[] }) {
  const [q,setQ]=useState(""); const ref=useRef(null);
  useEffect(()=>{ref.current?.focus();const esc=e=>{if(e.key==="Escape")onClose()};window.addEventListener("keydown",esc);return()=>window.removeEventListener("keydown",esc);},[]);
  const query=q.trim().toLowerCase();
  const match=ep=>ep.title.toLowerCase().includes(query)||(ep.guest||"").toLowerCase().includes(query)||(ep.tags||[]).some(t=>t.toLowerCase().includes(query))||(ep.num||"").toLowerCase().includes(query);
  const demoR=query.length<2?[]:EPS.filter(match);
  const uplR=query.length<2?[]:uploadedEps.filter(match);
  const total=demoR.length+uplR.length;
  const Row=({ep,isUploaded})=>(
    <div onClick={()=>{nav("episode",ep);onClose();}} style={{display:"flex",gap:14,alignItems:"center",padding:"12px 16px",background:"rgba(255,255,255,.04)",border:"1px solid var(--bdr)",borderRadius:2,cursor:"pointer",transition:"all .2s",marginBottom:4}} onMouseEnter={e=>{e.currentTarget.style.background=isUploaded?"rgba(74,222,128,.07)":"rgba(245,166,35,.07)";e.currentTarget.style.borderColor=isUploaded?"rgba(74,222,128,.3)":"rgba(245,166,35,.2)"}} onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,.04)";e.currentTarget.style.borderColor="var(--bdr)"}}>
      <img src={ep.img} alt="" style={{width:44,height:44,objectFit:"cover",borderRadius:2,flexShrink:0}} />
      <div style={{flex:1,minWidth:0}}>
        {isUploaded&&<div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><StorageBadge mode={ep._storageMode||"local"} /><span style={{fontSize:8,fontFamily:"'JetBrains Mono'",color:"#4ade80"}}>YOUR UPLOAD</span></div>}
        <div style={{fontSize:13,fontWeight:600,color:"var(--c)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ep.title}</div>
        <div style={{fontSize:10,color:"var(--g)",marginTop:2}}>{ep.guest||ep.host}{ep.dur?` · ${ep.dur}`:""}</div>
      </div>
      <button onClick={e=>{e.stopPropagation();onPlay(ep);onClose();}} style={{width:32,height:32,borderRadius:"50%",background:"var(--a)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#070707"}}>▶</button>
    </div>
  );
  return (
    <div className="search-overlay" onClick={onClose}>
      <div style={{width:"100%",maxWidth:800,display:"flex",flexDirection:"column",alignItems:"center"}} onClick={e=>e.stopPropagation()}>
        <div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:14}}>// SEARCH_ARCHIVE</div>
        <input ref={ref} className="search-input-big" placeholder="Search episodes, uploads, guests…" value={q} onChange={e=>setQ(e.target.value)} />
        <div className="mn" style={{fontSize:9,color:"rgba(245,166,35,.4)",letterSpacing:".1em",marginBottom:32}}>{query.length<2?`${EPS.length+uploadedEps.length} episodes in archive`:`${total} result${total!==1?"s":""} found`}</div>
        {total>0&&(
          <div style={{width:"100%",maxWidth:700,display:"flex",flexDirection:"column",gap:6,maxHeight:"55vh",overflowY:"auto"}}>
            {uplR.length>0&&<><div className="mn" style={{fontSize:8,color:"#4ade80",letterSpacing:".1em",marginBottom:8,paddingLeft:4}}>YOUR UPLOADS</div>{uplR.map(ep=><Row key={ep.id} ep={ep} isUploaded />)}</>}
            {demoR.length>0&&<><div className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",marginBottom:8,paddingLeft:4}}>EPISODES</div>{demoR.map(ep=><Row key={ep.id} ep={ep} isUploaded={false} />)}</>}
          </div>
        )}
        {query.length>=2&&total===0&&<div style={{textAlign:"center",opacity:.5}}><div style={{fontSize:40,marginBottom:12}}>◎</div><p style={{fontSize:14,color:"var(--g)"}}>No results for "{q}"</p></div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HOME PAGE  (abridged — full hero + latest + platforms + CTA)
   ═══════════════════════════════════════════════════════════════ */
function Home({ nav, onPlay, uploadedEps=[] }) {
  const [heroIdx,setHeroIdx]=useState(0); const heroEps=EPS.slice(0,5);
  useEffect(()=>{const t=setInterval(()=>setHeroIdx(i=>(i+1)%heroEps.length),5500);return()=>clearInterval(t);},[]);
  const heroEp=heroEps[heroIdx];
  const handlePlayOrNav=(ep)=>{
    const hasMedia=ep.audioUrl||ep.videoUrl||ep.cloudAudioUrl||ep.cloudVideoUrl;
    if(hasMedia){onPlay(ep);}else{nav("episode",ep);}
  };
  return (
    <div>
      {/* Hero */}
      <section style={{minHeight:"100vh",display:"flex",flexDirection:"column",justifyContent:"center",position:"relative",overflow:"hidden",paddingTop:68,background:"#050505"}}>
        {heroEps.map((ep,i)=><div key={ep.id} style={{position:"absolute",inset:0,transition:"opacity 1.2s ease",opacity:i===heroIdx?1:0,zIndex:0}}><img src={ep.cover} alt="" style={{width:"100%",height:"100%",objectFit:"cover",opacity:.13,filter:"saturate(.2) blur(2px)",transform:"scale(1.06)"}} /></div>)}
        <div style={{position:"absolute",inset:0,background:"linear-gradient(135deg, rgba(7,7,7,.55) 0%, rgba(7,7,7,.98) 60%)",zIndex:1}} />
        <div style={{position:"absolute",top:0,width:"100vw",height:"1px",background:"linear-gradient(90deg,transparent,rgba(245,166,35,.4),transparent)",animation:"scanX 10s linear infinite",zIndex:2,pointerEvents:"none"}} />
        <div className="gbg" style={{position:"absolute",inset:0,zIndex:1,opacity:.4}} />
        <div className="wrap" style={{position:"relative",zIndex:3,padding:"clamp(60px,10vw,80px) clamp(16px,4vw,40px) 60px"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"clamp(16px,4vw,40px)",alignItems:"center"}}>
            <div style={{maxWidth:780}}>
              <div className="fu" style={{display:"flex",alignItems:"center",gap:10,marginBottom:24}}><div className="ld" /><span className="tag">Now Featured — {heroEp.num}</span><span className="tag tag-r">Season 3</span></div>
              <h1 className="bb fu d1" style={{fontSize:"clamp(48px,8.5vw,112px)",color:"var(--c)",lineHeight:.9,marginBottom:20}}>{heroEp.title.split(" ").map((w,i)=><span key={i} style={{display:"inline-block",marginRight:".16em",color:i%4===2?"var(--a)":"var(--c)",transition:"color .6s"}}>{w}</span>)}</h1>
              <p className="fu d2" style={{fontSize:15,color:"var(--g)",maxWidth:500,lineHeight:1.82,marginBottom:32,fontWeight:300}}>{heroEp.desc.slice(0,145)}…</p>
              <div className="fu d3" style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:44}}>
                <button className="btn btn-a" style={{fontSize:11}} onClick={()=>handlePlayOrNav(heroEp)}><span>▶</span> Play Episode</button>
                <button className="btn btn-g" style={{fontSize:11}} onClick={()=>nav("episodes")}>Browse All →</button>
                <button className="btn btn-g" style={{fontSize:11}} onClick={()=>nav("upload")}>Upload Content ↑</button>
              </div>
              <div className="fu d4" style={{display:"inline-flex",alignItems:"center",gap:14,padding:"14px 20px",background:"rgba(10,10,10,.9)",border:"1px solid var(--bdr)",borderRadius:3,backdropFilter:"blur(16px)"}}>
                <img src={heroEp.img} alt="" style={{width:46,height:46,borderRadius:"50%",objectFit:"cover",border:"2px solid var(--a)",flexShrink:0}} />
                <div><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".1em",marginBottom:2}}>FEATURED GUEST</div><div style={{fontSize:14,fontWeight:600,color:"var(--c)"}}>{heroEp.guest}</div><div style={{fontSize:11,color:"var(--g)"}}>{heroEp.role}</div></div>
                <div style={{paddingLeft:16,borderLeft:"1px solid var(--bdr)"}}><div className="mn" style={{fontSize:8,color:"var(--g)",marginBottom:2}}>DURATION</div><div style={{fontSize:14,fontWeight:700,color:"var(--c)"}}>{heroEp.dur}</div></div>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8,alignItems:"center"}}>{heroEps.map((ep,i)=><button key={ep.id} onClick={()=>setHeroIdx(i)} style={{width:3,height:i===heroIdx?28:10,borderRadius:2,background:i===heroIdx?"var(--a)":"rgba(255,255,255,.2)",border:"none",cursor:"pointer",transition:"all .4s",padding:0}} />)}</div>
          </div>
        </div>
        <div style={{position:"relative",zIndex:3,borderTop:"1px solid var(--bdr)",background:"rgba(0,0,0,.5)",backdropFilter:"blur(12px)"}}>
          <div className="wrap"><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",padding:"20px 0",gap:16}}>{[["1M+","Monthly Listeners"],["48","Episodes"],["14K+","5★ Reviews"],["94","Countries"]].map(([v,l],i)=><div key={i} style={{borderLeft:i>0?"1px solid var(--bdr)":undefined,paddingLeft:i>0?16:0}}><div className="bb" style={{fontSize:34,color:"var(--a)",lineHeight:1}}>{v}</div><div className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",marginTop:3,textTransform:"uppercase"}}>{l}</div></div>)}</div></div>
        </div>
      </section>
      <Ticker />
      {/* Latest releases */}
      <section className="sec" style={{background:"var(--d)"}}>
        <div className="wrap">
          <Rv><div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:40,flexWrap:"wrap",gap:16}}><div><div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:10}}>// RECENT_DROPS</div><h2 className="bb" style={{fontSize:"clamp(42px,6vw,72px)",color:"var(--c)",lineHeight:.92}}>Latest<br /><em className="sf" style={{color:"var(--a)"}}>Releases</em></h2></div><button className="btn btn-g" onClick={()=>nav("episodes")}>View All →</button></div></Rv>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            {(()=>{
              const combined=[...uploadedEps,...EPS];
              const seen=new Set();
              const deduped=combined.filter(ep=>{const k=String(ep.id);if(seen.has(k))return false;seen.add(k);return true;});
              return deduped.slice(0,5).map((ep,i)=>{
              const mIcon=ep.mediaType==="video"?"🎬":ep.mediaType==="song"?"🎵":null;
              return (
              <Rv key={ep.id||i} delay={i*.06}>
                <div className="card" style={{display:"flex",alignItems:"center",gap:18,padding:"16px 20px",cursor:"pointer",transition:"all .25s",outline:ep.isLocal||ep._storageMode?"1px solid rgba(74,222,128,.15)":"none"}} onClick={()=>nav("episode",ep)} onMouseEnter={e=>{e.currentTarget.style.background="#141414";e.currentTarget.style.paddingLeft="26px"}} onMouseLeave={e=>{e.currentTarget.style.background="var(--card)";e.currentTarget.style.paddingLeft="20px"}}>
                  <div className="bb" style={{fontSize:22,color:"rgba(245,166,35,.13)",minWidth:30,lineHeight:1,flexShrink:0}}>{String(i+1).padStart(2,"00")}</div>
                  <img src={ep.img||ep.cover} alt="" style={{width:58,height:58,objectFit:"cover",borderRadius:2,flexShrink:0,border:"1px solid var(--bdr)"}} />
                  <div style={{flex:1,minWidth:0}}><div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}>{ep.num&&<span className="tag" style={{fontSize:8}}>{ep.num}</span>}{mIcon&&<span className="mn" style={{fontSize:9}}>{mIcon}</span>}{ep.isNew&&<span className="tag tag-r" style={{fontSize:8}}>New</span>}{ep._storageMode&&<StorageBadge mode={ep._storageMode} />}{(ep.tags||[]).slice(0,2).map(t=><span key={t} className="mn" style={{fontSize:8,color:"var(--g)",opacity:.65}}>{t}</span>)}</div><div style={{fontSize:14,fontWeight:600,color:"var(--c)",marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ep.title}</div><div style={{fontSize:11,color:"var(--g)"}}>{ep.guest||ep.host} · {ep.date||"Uploaded"}</div></div>
                  <div style={{textAlign:"right",flexShrink:0,marginRight:8}}><div style={{fontSize:12,fontWeight:600,color:"var(--c)"}}>{ep.dur||"—"}</div><div className="mn" style={{fontSize:8,color:"var(--g)"}}>{ep.plays||"Uploaded"}</div></div>
                  <button onClick={e=>{e.stopPropagation();handlePlayOrNav(ep);}} style={{width:40,height:40,borderRadius:"50%",background:"var(--a2)",border:"1px solid rgba(245,166,35,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"var(--a)",transition:"all .2s",flexShrink:0}} onMouseEnter={e=>{e.currentTarget.style.background="var(--a)";e.currentTarget.style.color="#070707"}} onMouseLeave={e=>{e.currentTarget.style.background="var(--a2)";e.currentTarget.style.color="var(--a)"}}>▶</button>
                </div>
              </Rv>
            );});
            })()}
          </div>
        </div>
      </section>
      {/* Platforms */}
      <section style={{padding:"60px 0",background:"var(--d2)",borderTop:"1px solid var(--bdr)",borderBottom:"1px solid var(--bdr)"}}>
        <div className="wrap"><Rv><div style={{textAlign:"center",marginBottom:36}}><div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:10}}>// LISTEN_ON</div><h2 className="bb" style={{fontSize:"clamp(36px,5vw,60px)",color:"var(--c)",lineHeight:.92}}>Tune In <em className="sf" style={{color:"var(--a)"}}>Anywhere</em></h2></div></Rv>
          <Rv delay={.1}><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12}}>{PLATFORMS.map(p=><a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"20px 14px",background:"rgba(255,255,255,.02)",border:"1px solid var(--bdr)",borderRadius:4,cursor:"pointer",transition:"all .25s",textDecoration:"none"}} onMouseEnter={e=>{e.currentTarget.style.borderColor=p.color;e.currentTarget.style.background=p.color+"0d";e.currentTarget.style.transform="translateY(-3px)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.background="rgba(255,255,255,.02)";e.currentTarget.style.transform="none"}}><span style={{fontSize:26}}>{p.icon}</span><div style={{textAlign:"center"}}><div style={{fontSize:11,fontWeight:700,color:"var(--c)",marginBottom:2}}>{p.name}</div><div className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".05em"}}>{p.sub}</div></div></a>)}</div></Rv>
        </div>
      </section>
      <section className="sec" style={{position:"relative",overflow:"hidden",background:"var(--d)"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 60% 50% at 50% 50%, rgba(245,166,35,.07) 0%, transparent 70%)"}} />
        <div className="wrap" style={{position:"relative",textAlign:"center"}}>
          <Rv><div className="tag" style={{margin:"0 auto 18px",display:"inline-flex"}}>Never Miss an Episode</div><h2 className="bb" style={{fontSize:"clamp(44px,7.5vw,88px)",color:"var(--c)",lineHeight:.92,marginBottom:18}}>Subscribe.<br /><em className="sf" style={{color:"var(--a)"}}>Stay Curious.</em></h2><p style={{fontSize:14,color:"var(--g)",maxWidth:380,margin:"0 auto 32px",lineHeight:1.82,fontWeight:300}}>Join over a million curious minds. New episodes drop every Friday.</p><div style={{display:"flex",justifyContent:"center",gap:10,flexWrap:"wrap"}}><button className="btn btn-a" onClick={()=>nav("subscribe")} style={{fontSize:11}}>Subscribe Now →</button><button className="btn btn-g" onClick={()=>nav("upload")} style={{fontSize:11}}>Upload Content ↑</button></div></Rv>
        </div>
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   EPISODES PAGE  (with 3 category sections)
   ═══════════════════════════════════════════════════════════════ */
function Episodes({ nav, onPlay, uploadedEps=[], loading=false }) {
  const [filter,setFilter]=useState("All");
  const [categoryFilter,setCategoryFilter]=useState("all");
  const allTags=["All",...new Set(EPS.flatMap(e=>e.tags))];
  const uploadedVideos=uploadedEps.filter(e=>e.mediaType==="video");
  const uploadedAudios=uploadedEps.filter(e=>e.mediaType==="audio"||!e.mediaType);
  const uploadedSongs=uploadedEps.filter(e=>e.mediaType==="song");

  // All uploaded eps filtered by podcast category
  const allUploaded=uploadedEps.filter(e=>categoryFilter==="all"||(e.podcastCategory||"other")===categoryFilter);
  const filtUplVideos=allUploaded.filter(e=>e.mediaType==="video");
  const filtUplAudios=allUploaded.filter(e=>e.mediaType==="audio"||!e.mediaType);
  const filtUplSongs=allUploaded.filter(e=>e.mediaType==="song");

  const filteredDemo=filter==="All"?EPS:EPS.filter(e=>e.tags.includes(filter));

  // Count uploaded per category (excluding "all")
  const catCount=id=>id==="all"?uploadedEps.length:uploadedEps.filter(e=>(e.podcastCategory||"other")===id).length;

  const EpCard=({ep,i})=>{
    const isUploaded=ep.isLocal, playUrl=ep.audioUrl||ep.videoUrl||ep.cloudAudioUrl||ep.cloudVideoUrl;
    const mColor=ep.mediaType==="video"?"#8b5cf6":ep.mediaType==="song"?"#ec4899":"var(--a)";
    const mIcon=ep.mediaType==="video"?"🎬":ep.mediaType==="song"?"🎵":"🎙";
    return (
      <Rv delay={i*.045}>
        <div className="card hl" style={{overflow:"hidden",outline:isUploaded?"1px solid rgba(74,222,128,.22)":"none"}}>
          <div style={{position:"relative",height:190,overflow:"hidden"}}>
            <img src={ep.img} alt="" style={{width:"100%",height:"100%",objectFit:"cover",filter:"saturate(.75)",transition:"transform .6s,filter .4s"}} onMouseOver={e=>{e.currentTarget.style.transform="scale(1.06)";e.currentTarget.style.filter="saturate(1)"}} onMouseOut={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.filter="saturate(.75)"}} />
            <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(7,7,7,.9) 0%,transparent 55%)"}} />
            {isUploaded&&<span style={{position:"absolute",top:10,left:10,background:mColor,color:ep.mediaType==="song"?"#fff":"#070707",fontFamily:"'JetBrains Mono'",fontSize:8,fontWeight:700,letterSpacing:".08em",padding:"3px 8px",borderRadius:2}}>{mIcon} {(ep.mediaType||"audio").toUpperCase()}</span>}
            {!isUploaded&&ep.isNew&&<span className="tag tag-r" style={{position:"absolute",top:10,left:10,fontSize:8}}>New</span>}
            <span className="tag" style={{position:"absolute",top:10,right:10,fontSize:8}}>{ep.num}</span>
            {ep._storageMode&&<div style={{position:"absolute",bottom:10,left:10}}><StorageBadge mode={ep._storageMode} /></div>}
            <button onClick={()=>onPlay(ep)} style={{position:"absolute",bottom:10,right:10,width:38,height:38,borderRadius:"50%",background:playUrl?"var(--a)":"rgba(138,134,128,.4)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#070707",transition:"all .2s",minWidth:44,minHeight:44}} onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.15)";e.currentTarget.style.boxShadow="0 0 20px var(--a3)"}} onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.boxShadow="none"}}>▶</button>
          </div>
          <div style={{padding:"16px 18px"}}>
            <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:9}}>
              {ep.podcastCategory&&ep.isLocal&&(()=>{const cat=PODCAST_CATEGORIES.find(c=>c.id===ep.podcastCategory);return cat?<span style={{fontSize:8,fontFamily:"'JetBrains Mono'",color:cat.color,background:cat.accent,border:`1px solid ${cat.border}`,padding:"2px 7px",borderRadius:2,letterSpacing:".06em"}}>{cat.icon} {cat.label}</span>:null;})()}
              {ep.tags.map(t=><span key={t} className="mn" style={{fontSize:8,color:"var(--g)"}}>{t}</span>)}
            </div>
            <h3 className="sf" style={{fontSize:15,fontWeight:400,color:"var(--c)",marginBottom:6,lineHeight:1.3,cursor:"pointer"}} onClick={()=>nav("episode",ep)}>{ep.title}</h3>
            {isUploaded&&ep.fileName&&<div className="mn" style={{fontSize:9,color:"rgba(74,222,128,.55)",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ep.fileName}</div>}
            {isUploaded&&(ep.cloudAudioUrl||ep.cloudVideoUrl)&&<div className="mn" style={{fontSize:8,color:"var(--cloud-c)",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>☁ {ep.cloudAudioUrl||ep.cloudVideoUrl}</div>}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:"1px solid var(--bdr)",paddingTop:10,marginTop:8}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}><img src={ep.img} alt="" style={{width:22,height:22,borderRadius:"50%",objectFit:"cover"}} /><span style={{fontSize:10,fontWeight:600,color:"var(--c)"}}>{(ep.guest||"").split(" ")[0]}</span></div>
              <div style={{display:"flex",alignItems:"center",gap:6}}><span className="mn" style={{fontSize:8,color:"var(--g)"}}>{ep.dur}</span>{!isUploaded&&<ProgressRing pct={Math.round((parseInt(ep.plays)/120)*100)} size={28} />}{isUploaded&&<span style={{fontSize:9,color:"rgba(74,222,128,.8)",fontFamily:"'JetBrains Mono'"}}>✓</span>}</div>
            </div>
          </div>
        </div>
      </Rv>
    );
  };

  const SectionHeader=({icon,label,color,count,accentBg})=>(
    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20,paddingBottom:14,borderBottom:`2px solid ${color}22`}}>
      <div style={{width:42,height:42,borderRadius:"50%",background:accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{icon}</div>
      <div><div className="mn" style={{fontSize:8,color,letterSpacing:".14em",marginBottom:2}}>// {label.toUpperCase()}_EPISODES</div><div className="bb" style={{fontSize:28,color:"var(--c)",lineHeight:1}}>{label} <span style={{fontSize:16,color:"var(--g)",fontFamily:"'DM Sans'"}}>({count})</span></div></div>
    </div>
  );

  const INIT=6;
  const Section=({items,icon,label,color,accentBg,onUpload})=>{
    const [expanded,setExpanded]=useState(false);
    const visible=expanded?items:items.slice(0,INIT), hasMore=items.length>INIT+2;
    return (
      <div>
        <SectionHeader icon={icon} label={label} color={color} count={items.length} accentBg={accentBg} />
        {loading?<div className="ep-cards-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>{[1,2,3].map(i=><SkeletonCard key={i} />)}</div>
        :items.length===0?<div style={{textAlign:"center",padding:"48px 20px",border:`1px dashed ${color}33`,borderRadius:4,background:`${color}05`}}><div style={{fontSize:40,marginBottom:12,opacity:.5}}>{icon}</div><div className="mn" style={{fontSize:10,color:"var(--g)",letterSpacing:".1em",marginBottom:16}}>No {label.toLowerCase()} uploaded yet</div><button className="btn btn-a" onClick={onUpload} style={{padding:"9px 22px",fontSize:10}}>Upload {label} →</button></div>
        :<>
          <div className="ep-cards-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>{visible.map((ep,i)=><EpCard key={ep.id} ep={ep} i={i} />)}</div>
          {hasMore&&<div style={{textAlign:"center",marginTop:22}}><button onClick={()=>setExpanded(v=>!v)} style={{padding:"11px 28px",background:"transparent",border:`1px solid ${color}55`,borderRadius:3,color,fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".1em",cursor:"pointer",transition:"all .25s"}} onMouseEnter={e=>{e.currentTarget.style.background=`${color}11`;e.currentTarget.style.borderColor=color}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor=`${color}55`}}>{expanded?`▲ SHOW LESS`:`▼ SHOW ALL ${items.length} ${label.toUpperCase()}`}</button></div>}
        </>}
      </div>
    );
  };

  return (
    <div style={{paddingTop:68}}>
      <section style={{padding:"72px 0 52px",background:"var(--d2)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
        <div className="wrap" style={{position:"relative"}}>
          <Rv>
            <div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:14}}>// THE_ARCHIVE — {EPS.length+uploadedEps.length} total{uploadedEps.length>0&&<span style={{marginLeft:12,color:"#4ade80"}}>· {uploadedEps.length} uploaded by you</span>}</div>
            <h1 className="bb" style={{fontSize:"clamp(56px,9vw,112px)",color:"var(--c)",lineHeight:.92,marginBottom:20}}>The <em className="sf" style={{color:"var(--a)"}}>Archive</em></h1>
            <p style={{fontSize:15,color:"var(--g)",maxWidth:440,fontWeight:300,lineHeight:1.78}}>Every conversation, every mind. Browse by category below.</p>
            <div style={{display:"flex",gap:20,marginTop:28,flexWrap:"wrap"}}>
              {[{icon:"🎬",label:"Videos",count:uploadedVideos.length,color:"#8b5cf6"},{icon:"🎙",label:"Audio",count:uploadedAudios.length+EPS.length,color:"var(--a)"},{icon:"🎵",label:"Songs",count:uploadedSongs.length,color:"#ec4899"}].map(s=><div key={s.label} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",background:"rgba(255,255,255,.03)",border:"1px solid var(--bdr)",borderRadius:3}}><span style={{fontSize:14}}>{s.icon}</span><span className="bb" style={{fontSize:20,color:s.color,lineHeight:1}}>{s.count}</span><span className="mn" style={{fontSize:9,color:"var(--g)",letterSpacing:".08em"}}>{s.label}</span></div>)}
            </div>
          </Rv>
        </div>
      </section>

      {/* ── Podcast Category Filter Bar (filters uploaded episodes by category) ── */}
      {uploadedEps.length>0&&(
        <div style={{background:"var(--d2)",borderBottom:"1px solid var(--bdr)"}}>
          <div className="wrap" style={{padding:"14px var(--container-padding)"}}>
            <div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".14em",marginBottom:10}}>// FILTER_BY_CATEGORY</div>
            <div style={{display:"flex",gap:7,overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",paddingBottom:2}}>
              {PODCAST_CATEGORIES.map(c=>{
                const cnt=catCount(c.id);
                const active=categoryFilter===c.id;
                return (
                  <button key={c.id} onClick={()=>setCategoryFilter(c.id)}
                    style={{display:"flex",alignItems:"center",gap:6,padding:"8px 14px",borderRadius:2,border:`1px solid ${active?c.border:"var(--bdr)"}`,background:active?c.accent:"transparent",color:active?c.color:"var(--g)",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".07em",textTransform:"uppercase",cursor:"pointer",transition:"all .2s",whiteSpace:"nowrap",flexShrink:0,minHeight:36}}
                    onMouseEnter={e=>{if(!active){e.currentTarget.style.borderColor=c.border;e.currentTarget.style.color=c.color;}}}
                    onMouseLeave={e=>{if(!active){e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.color="var(--g)";}}}
                  >
                    <span style={{fontSize:13}}>{c.icon}</span>
                    {c.label}
                    {cnt>0&&<span style={{fontSize:8,background:active?c.color+"33":"rgba(255,255,255,.06)",color:active?c.color:"var(--g)",borderRadius:10,padding:"1px 6px",marginLeft:2}}>{cnt}</span>}
                  </button>
                );
              })}
            </div>
            {categoryFilter!=="all"&&(()=>{const cat=PODCAST_CATEGORIES.find(c=>c.id===categoryFilter);return<div style={{marginTop:10,fontSize:11,color:"var(--g)"}}>Showing <strong style={{color:cat?.color}}>{cat?.icon} {cat?.label}</strong> — {allUploaded.length} upload{allUploaded.length!==1?"s":""}. <button onClick={()=>setCategoryFilter("all")} style={{background:"none",border:"none",color:"var(--a)",cursor:"pointer",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".07em",textDecoration:"underline",padding:0}}>Clear filter</button></div>;})()}
          </div>
        </div>
      )}


      {/* Videos */}
      <section style={{padding:"56px 0 48px",background:"var(--d)",borderBottom:"1px solid var(--bdr)"}}>
        <div className="wrap"><Section items={filtUplVideos} icon="🎬" label="Videos" color="#8b5cf6" accentBg="rgba(139,92,246,.12)" onUpload={()=>nav("upload")} /></div>
      </section>
      {/* Audio */}
      <section style={{padding:"56px 0 48px",background:"var(--d2)",borderBottom:"1px solid var(--bdr)"}}>
        <div className="wrap"><Section items={[...filtUplAudios,...filteredDemo]} icon="🎙" label="Audio Podcasts" color="var(--a)" accentBg="rgba(245,166,35,.1)" onUpload={()=>nav("upload")} /></div>
      </section>
      {/* Songs */}
      <section style={{padding:"56px 0 56px",background:"var(--d)"}}>
        <div className="wrap"><Section items={filtUplSongs} icon="🎵" label="Songs" color="#ec4899" accentBg="rgba(236,72,153,.1)" onUpload={()=>nav("upload")} /></div>
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   EPISODE DETAIL (compact)
   ═══════════════════════════════════════════════════════════════ */
function EpisodeDetail({ ep, onPlay }) {
  const [activeTab,setActiveTab]=useState("notes"),[liked,setLiked]=useState(false),[scrollY,setScrollY]=useState(0);
  if(!ep)ep=EPS[0];
  useEffect(()=>{const fn=()=>setScrollY(window.scrollY);window.addEventListener("scroll",fn,{passive:true});return()=>window.removeEventListener("scroll",fn);},[]);
  const hasAudio=!!(ep.audioUrl||ep.cloudAudioUrl);
  const waveData=useRef(Array.from({length:120},()=>15+Math.random()*75));
  // Parse chapter timestamp "MM:SS" → seconds
  const parseChapTime=t=>{const p=t.split(":");return p.length===2?parseInt(p[0])*60+parseInt(p[1]):0;};
  const totalDurSec=ep.dur?ep.dur.split(":").reduce((a,b,i,arr)=>a+parseInt(b)*(arr.length-1-i===0?1:60),0):0;
  return (
    <div style={{paddingTop:68,background:"var(--d)"}}>
      {/* Cinematic hero */}
      <section style={{position:"relative",overflow:"hidden",minHeight:"clamp(520px,70vh,780px)",display:"flex",alignItems:"flex-end"}}>
        <div style={{position:"absolute",inset:"-10%",transform:`translateY(${scrollY*0.28}px)`,willChange:"transform"}}><img src={ep.cover||ep.img} alt="" style={{width:"100%",height:"100%",objectFit:"cover",filter:"saturate(.45) brightness(.55)"}} /></div>
        <div style={{position:"absolute",inset:0,background:"linear-gradient(to top, var(--d) 0%, rgba(7,7,7,.75) 45%, rgba(7,7,7,.3) 100%)"}} />
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg, transparent 0%, var(--a) 30%, var(--r) 70%, transparent 100%)"}} />
        <div className="wrap" style={{position:"relative",zIndex:2,padding:"clamp(48px,10vw,80px) var(--container-padding) clamp(40px,7vw,64px)"}}>
          <Rv>
            <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>{ep.tags.map((t,i)=><span key={t} className="tag" style={{fontSize:8,opacity:i===0?1:.65}}>{t}</span>)}{ep.isNew&&<span className="tag tag-r" style={{fontSize:8}}>New</span>}{ep._storageMode&&<StorageBadge mode={ep._storageMode} />}</div>
            <h1 className="bb" style={{fontSize:"clamp(40px,8.5vw,108px)",color:"var(--c)",lineHeight:.88,marginBottom:"clamp(20px,4vw,30px)",maxWidth:900}}>{ep.title}</h1>
            <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",marginBottom:28}}>
              <img src={ep.img} alt="" style={{width:48,height:48,borderRadius:"50%",objectFit:"cover",border:"2px solid var(--a)",flexShrink:0}} />
              <div><div style={{fontSize:14,fontWeight:700,color:"var(--c)"}}>{ep.guest}</div><div style={{fontSize:11,color:"var(--g)"}}>{ep.role}</div></div>
              {ep._storageMode&&<StorageBadge mode={ep._storageMode} />}
              {ep.cloudAudioUrl&&<span className="mn" style={{fontSize:8,color:"var(--cloud-c)"}}>☁ cloud audio</span>}
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <button onClick={()=>onPlay(ep)} className="btn btn-a" style={{fontSize:11,padding:"10px 24px",gap:8}}><span>▶</span> Play Episode</button>
              <button onClick={()=>setLiked(v=>!v)} style={{padding:"10px 16px",background:liked?"rgba(245,166,35,.12)":"rgba(255,255,255,.04)",border:`1px solid ${liked?"var(--a)":"var(--bdr)"}`,color:liked?"var(--a)":"var(--g)",cursor:"pointer",borderRadius:2,fontSize:16,transition:"all .2s",display:"flex",alignItems:"center",justifyContent:"center"}}>{liked?"♥":"♡"}</button>
            </div>
          </Rv>
        </div>
      </section>
      {/* Episode info bar — replaces the fake scrubber */}
      <section style={{background:"linear-gradient(to bottom,var(--d) 0%,var(--d2) 100%)",borderBottom:"1px solid var(--bdr)",position:"sticky",top:"var(--navbar-h)",zIndex:40}}>
        <div className="wrap" style={{padding:"14px var(--container-padding)"}}>
          <div className="ep-player-row" style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
            <button onClick={()=>onPlay(ep)} style={{width:52,height:52,borderRadius:"50%",background:hasAudio?"var(--a)":"rgba(245,166,35,.12)",border:`2px solid ${hasAudio?"var(--a)":"rgba(245,166,35,.3)"}`,cursor:hasAudio?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:hasAudio?"#070707":"var(--a)",flexShrink:0,transition:"all .25s",opacity:hasAudio?1:.55}} title={hasAudio?"Play in player":"No audio file attached"}>▶</button>
            {/* Decorative waveform — visual only, play routes to PlayerBar */}
            <div style={{flex:1,minWidth:180}}>
              <div style={{display:"flex",alignItems:"flex-end",gap:1,height:40,marginBottom:4,borderRadius:2,overflow:"hidden",padding:"0 1px"}}>
                {waveData.current.map((h,i)=><div key={i} style={{flex:1,minWidth:1,borderRadius:"1px 1px 0 0",height:`${h}%`,background:`rgba(245,166,35,${0.12+h/400})`,transformOrigin:"bottom"}} />)}
              </div>
              <div style={{height:3,background:"rgba(255,255,255,.08)",borderRadius:2}} />
            </div>
            <div className="mn" style={{fontSize:10,color:"var(--g)",flexShrink:0,minWidth:60,textAlign:"center"}}><span style={{color:"var(--c)"}}>{ep.dur}</span></div>
            <div className="ep-speed-pills" style={{display:"flex",gap:3,flexShrink:0}}>
              {["0.8×","1×","1.5×","2×"].map(s=><span key={s} style={{padding:"4px 8px",border:"1px solid var(--bdr)",background:"transparent",color:"var(--g)",fontFamily:"'JetBrains Mono'",fontSize:8,borderRadius:2}}>{s}</span>)}
            </div>
            {!hasAudio&&<div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".06em"}}>⚠ Upload audio to enable playback</div>}
          </div>
        </div>
      </section>
      {/* Content */}
      <section style={{background:"var(--d)",padding:"clamp(40px,7vw,72px) 0"}}>
        <div className="wrap">
          <div className="ep-grid">
            <div className="ep-main-order">
              <div style={{display:"flex",gap:0,borderBottom:"1px solid var(--bdr)",marginBottom:36}}>
                {[{id:"notes",label:"Show Notes"},{id:"transcript",label:"Transcript"},{id:"resources",label:"Resources"}].map(t=><button key={t.id} onClick={()=>setActiveTab(t.id)} style={{padding:"10px 20px",background:"none",border:"none",borderBottom:`2px solid ${activeTab===t.id?"var(--a)":"transparent"}`,color:activeTab===t.id?"var(--c)":"var(--g)",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".1em",textTransform:"uppercase",cursor:"pointer",transition:"all .2s",marginBottom:-1}}>{t.label}</button>)}
              </div>
              <Rv>
                {activeTab==="notes"&&<><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".16em",marginBottom:10}}>// ABOUT_THIS_EPISODE</div><p style={{fontSize:15,color:"rgba(240,237,230,.75)",lineHeight:1.92,marginBottom:18,fontWeight:300}}>{ep.desc}</p><div style={{position:"relative",margin:"32px 0",padding:"24px 28px 24px 36px",background:"rgba(245,166,35,.04)",borderLeft:"3px solid var(--a)",borderRadius:"0 4px 4px 0"}}><p className="sf" style={{fontSize:"clamp(16px,3vw,20px)",color:"var(--c)",lineHeight:1.55,fontStyle:"italic",margin:0}}>Every great conversation is two people trying to think out loud together.</p><div style={{marginTop:12,fontSize:11,color:"var(--g)"}}>— {ep.guest}</div></div></>}
                {activeTab==="transcript"&&<><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".16em",marginBottom:18}}>// AUTO-GENERATED TRANSCRIPT</div>{[{time:"00:00",speaker:"Host",text:`Welcome to Signal & Noise. Today I'm joined by ${ep.guest}.`},{time:"00:42",speaker:ep.guest,text:"Thanks for having me. This is a topic I've been wanting to talk about for a while."},{time:"01:15",speaker:"Host",text:"Let's start from the beginning. How did you first get into this field?"}].map((line,i)=><div key={i} style={{display:"flex",gap:16,padding:"12px 16px",background:i%2===0?"rgba(255,255,255,.02)":"transparent",borderRadius:3,marginBottom:8}}><span className="mn" style={{fontSize:9,color:"var(--a)",minWidth:36,flexShrink:0}}>{line.time}</span><div><span className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".08em",display:"block",marginBottom:4}}>{line.speaker.toUpperCase()}</span><p style={{fontSize:13,color:"rgba(240,237,230,.7)",lineHeight:1.75,margin:0,fontWeight:300}}>{line.text}</p></div></div>)}<div style={{padding:"14px 18px",background:"rgba(245,166,35,.04)",border:"1px dashed rgba(245,166,35,.2)",borderRadius:3,textAlign:"center"}}><span className="mn" style={{fontSize:9,color:"var(--g)",letterSpacing:".08em"}}>— Full transcript available for subscribers —</span></div></>}
                {activeTab==="resources"&&<><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".16em",marginBottom:18}}>// LINKS & RESOURCES</div>{[{type:"📖",title:"The Definitive Guide to "+ep.tags[0],source:"Amazon Books"},{type:"📄",title:"Research Paper: Advances in "+ep.tags[0],source:"arXiv"},{type:"🎙",title:"Related episode: Deep Dive",source:"Signal & Noise"}].map((res,i)=><a key={i} href="#" style={{display:"flex",gap:14,alignItems:"center",padding:"13px 16px",background:"rgba(255,255,255,.025)",border:"1px solid var(--bdr)",borderRadius:3,textDecoration:"none",transition:"all .2s",marginBottom:8}} onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(245,166,35,.25)";e.currentTarget.style.background="rgba(245,166,35,.04)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.background="rgba(255,255,255,.025)"}}><span style={{fontSize:18,flexShrink:0}}>{res.type}</span><div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:600,color:"var(--c)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{res.title}</div><div className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".06em",marginTop:3}}>{res.source}</div></div><span style={{fontSize:12,color:"var(--a)",flexShrink:0}}>↗</span></a>)}</>}
              </Rv>
            </div>
            {/* Sidebar: chapters */}
            <div className="ep-sidebar-order">
              <Rv delay={.1}>
                <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:3,overflow:"hidden"}}>
                  <div style={{padding:"14px 18px",borderBottom:"1px solid var(--bdr)",display:"flex",alignItems:"center",justifyContent:"space-between"}}><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".14em"}}>// CHAPTERS</div><span style={{fontSize:10,color:"var(--g)"}}>{ep.chapters.length} chapters</span></div>
                  <div style={{padding:"8px 0"}}>
                    {ep.chapters.length===0?<div style={{padding:"20px 18px",fontSize:11,color:"var(--g)",textAlign:"center",opacity:.6}}>No chapters defined.</div>:ep.chapters.map((c,i)=>{return(<button key={i} onClick={()=>{onPlay(ep);}} style={{display:"flex",gap:12,alignItems:"center",padding:"10px 18px",background:"transparent",border:"none",borderLeft:"3px solid transparent",cursor:"pointer",textAlign:"left",transition:"all .18s",width:"100%",minHeight:44}} onMouseEnter={e=>{e.currentTarget.style.background="var(--a2)";e.currentTarget.style.borderLeftColor="var(--a)";}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderLeftColor="transparent";}}><div style={{width:20,height:20,borderRadius:"50%",background:"rgba(255,255,255,.07)",border:"1px solid rgba(255,255,255,.1)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span className="mn" style={{fontSize:7,color:"var(--g)"}}>{i+1}</span></div><div style={{flex:1,minWidth:0}}><div style={{fontSize:12,color:"rgba(240,237,230,.65)",fontWeight:400,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.l}</div><div className="mn" style={{fontSize:8,color:"var(--a)",marginTop:2,opacity:.7}}>{c.t}</div></div></button>);})}
                  </div>
                </div>
              </Rv>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   EDIT EPISODE MODAL
   ═══════════════════════════════════════════════════════════════ */
function EditEpisodeModal({ ep, onSave, onClose }) {
  const [form, setForm] = useState({
    title:       ep.title       || "",
    guest:       ep.guest       || ep.host || "",
    role:        ep.role        || "",
    desc:        ep.desc        || "",
    tags:        (ep.tags||[]).join(", "),
    num:         ep.num         || "",
    dur:         ep.dur         || "",
  });
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  const handleSave = () => {
    const updated = {
      ...ep,
      ...form,
      host:  form.guest,
      tags:  form.tags.split(",").map(t=>t.trim()).filter(Boolean),
    };
    onSave(updated);
    onClose();
  };

  const Field = ({label, k, multiline=false}) => (
    <div style={{marginBottom:16}}>
      <div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".12em",marginBottom:6}}>{label}</div>
      {multiline
        ? <textarea className="field" rows={3} value={form[k]} onChange={e=>set(k,e.target.value)}
            style={{width:"100%",resize:"vertical",fontFamily:"inherit",fontSize:12,lineHeight:1.6,padding:"10px 12px"}} />
        : <input className="field" value={form[k]} onChange={e=>set(k,e.target.value)}
            style={{width:"100%",fontSize:12,padding:"10px 12px"}} />}
    </div>
  );

  return (
    <div className="modal-bg" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modal-box" style={{maxWidth:520,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
          <div>
            <div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".14em",marginBottom:4}}>// EDIT_EPISODE</div>
            <div style={{fontSize:16,fontWeight:700,color:"var(--c)"}}>Edit Episode Details</div>
          </div>
          <button onClick={onClose} style={{background:"transparent",border:"1px solid var(--bdr)",borderRadius:2,color:"var(--g)",cursor:"pointer",width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>✕</button>
        </div>

        {/* Thumbnail preview */}
        {ep.img && (
          <div style={{marginBottom:20,display:"flex",gap:14,alignItems:"center",padding:"12px 14px",background:"rgba(255,255,255,.03)",border:"1px solid var(--bdr)",borderRadius:3}}>
            <img src={ep.img} alt="" style={{width:52,height:52,borderRadius:"50%",objectFit:"cover",border:"2px solid var(--a)",flexShrink:0}} />
            <div style={{fontSize:11,color:"var(--g)",lineHeight:1.6}}>
              <span style={{color:"var(--c)",fontWeight:600}}>{ep.title}</span><br/>
              <span className="mn" style={{fontSize:9}}>Thumbnail from upload · to change, re-upload the episode</span>
            </div>
          </div>
        )}

        <Field label="// EPISODE_TITLE" k="title" />
        <Field label="// GUEST_OR_HOST_NAME" k="guest" />
        <Field label="// ROLE_OR_TITLE" k="role" />
        <Field label="// EPISODE_NUMBER  (e.g. E001)" k="num" />
        <Field label="// DURATION  (e.g. 34:22)" k="dur" />
        <Field label="// TAGS  (comma-separated)" k="tags" />
        <Field label="// DESCRIPTION" k="desc" multiline />

        <div style={{display:"flex",gap:10,justifyContent:"flex-end",marginTop:8}}>
          <button onClick={onClose} className="btn btn-g" style={{fontSize:10,padding:"10px 18px"}}>Cancel</button>
          <button onClick={handleSave} className="btn btn-a" style={{fontSize:10,padding:"10px 22px"}}>Save Changes ✓</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SIMPLE PAGES  (Guests, About, Subscribe, Contact)
   ═══════════════════════════════════════════════════════════════ */
function Guests({ onPlay, uploadedEps=[], onEditEpisode }) {
  const [hovered,setHovered]=useState(null);
  const [showAll,setShowAll]=useState(false);
  const VISIBLE_COUNT=6;

  /* Build guest cards from uploaded episodes */
  const uploadedCards = uploadedEps.map(ep=>({
    id:    ep.id,
    name:  ep.guest || ep.host || ep.title,
    role:  ep.role  || ep.tags?.[0] || "Featured Guest",
    ep:    ep.num   || "",
    img:   ep.img   || ep.cover || FALLBACK_IMG,
    bio:   ep.desc  || "Uploaded episode.",
    tw:    "",
    _ep:   ep,
  }));

  /* Fill remaining slots with fake guests */
  const fakeCards = GUESTS.map(g=>({
    ...g,
    _ep: EPS.find(e=>e.num===g.ep)||EPS[0],
  }));

  const allCards = uploadedCards.length > 0
    ? [...uploadedCards, ...fakeCards]
    : fakeCards;

  const visibleCards = showAll ? allCards : allCards.slice(0, VISIBLE_COUNT);
  const hiddenCount  = allCards.length - VISIBLE_COUNT;

  return (
    <div style={{paddingTop:68}}>
      <section style={{position:"relative",minHeight:"460px",display:"flex",alignItems:"center",overflow:"hidden",background:"#050505"}}>
        <div style={{position:"absolute",inset:0,display:"grid",gridTemplateColumns:"repeat(6,1fr)"}}>
          {allCards.slice(0,6).map((g,i)=>(
            <div key={g.id??i} style={{overflow:"hidden"}}>
              <img src={g.img} alt={g.name} style={{width:"100%",height:"100%",objectFit:"cover",filter:"grayscale(1) brightness(.35) contrast(1.15)"}} />
            </div>
          ))}
        </div>
        <div style={{position:"absolute",inset:0,background:"linear-gradient(to right, #050505 30%, rgba(5,5,5,.82) 55%, rgba(5,5,5,.55) 100%)"}} />
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--a),var(--r),transparent)"}} />
        <div className="wrap" style={{position:"relative",zIndex:2,padding:"80px 0"}}>
          <Rv>
            <h1 className="bb" style={{fontSize:"clamp(56px,11vw,130px)",color:"var(--c)",lineHeight:.86,marginBottom:20}}>
              The <em className="sf" style={{color:"var(--a)"}}>Minds</em><br />We've Met
            </h1>
            <p style={{fontSize:"clamp(13px,2.5vw,15px)",color:"var(--g)",maxWidth:"min(420px,90vw)",fontWeight:300,lineHeight:1.9}}>
              {uploadedEps.length > 0
                ? `${uploadedEps.length} uploaded episode${uploadedEps.length>1?"s":""} · Click ▶ to play`
                : "World-class thinkers, researchers, and rebels who've sat across from us."}
            </p>
            {allCards.length > 0 && (
              <div style={{marginTop:24,display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:32,height:1,background:"var(--a)",opacity:.6}} />
                  <span className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".12em"}}>{allCards.length} GUESTS FEATURED</span>
                </div>
              </div>
            )}
          </Rv>
        </div>
      </section>

      <section className="sec" style={{background:"var(--d)"}}>
        <div className="wrap">
          {uploadedEps.length === 0 && (
            <div style={{textAlign:"center",padding:"24px 0 32px",marginBottom:8}}>
              <span className="mn" style={{fontSize:9,color:"var(--g)",letterSpacing:".1em"}}>
                NO UPLOADS YET — SHOWING SAMPLE GUESTS · UPLOAD AN EPISODE TO SEE IT HERE
              </span>
            </div>
          )}

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:2}}>
            {visibleCards.map((g,i)=>{
              const isHov=hovered===g.id;
              const ep = g._ep;
              return (
                <Rv key={g.id??i} delay={i*.06}>
                  <div
                    onMouseEnter={()=>setHovered(g.id)}
                    onMouseLeave={()=>setHovered(null)}
                    style={{position:"relative",overflow:"hidden",background:isHov?"rgba(245,166,35,.04)":"var(--card)",border:`1px solid ${isHov?"rgba(245,166,35,.28)":"var(--bdr)"}`,transition:"all .3s cubic-bezier(.16,1,.3,1)"}}
                  >
                    {isHov&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,var(--a),var(--r))"}} />}
                    <div style={{padding:"28px 26px 22px"}}>
                      <div style={{display:"flex",gap:16,marginBottom:18,alignItems:"flex-start"}}>
                        <div style={{position:"relative",flexShrink:0}}>
                          <div style={{width:76,height:76,borderRadius:"50%",padding:2,background:isHov?"linear-gradient(135deg,var(--a),var(--r))":"rgba(255,255,255,.08)"}}>
                            <img src={g.img} alt={g.name} style={{width:"100%",height:"100%",borderRadius:"50%",objectFit:"cover",filter:isHov?"none":"grayscale(.3)",display:"block"}} />
                          </div>
                          <div style={{position:"absolute",bottom:0,right:0,width:20,height:20,borderRadius:"50%",background:"var(--a)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,border:"2.5px solid var(--card)",fontWeight:700,color:"#070707"}}>✓</div>
                        </div>
                        <div style={{flex:1,minWidth:0,paddingTop:4}}>
                          <h3 style={{fontSize:17,fontWeight:700,color:"var(--c)",marginBottom:4}}>{g.name}</h3>
                          <div style={{fontSize:11,color:"var(--a)",fontWeight:500,marginBottom:5}}>{g.role}</div>
                          {g.tw&&<div className="mn" style={{fontSize:8,color:"var(--g)"}}>{g.tw}</div>}
                        </div>
                        {g.ep&&(
                          <div style={{flexShrink:0}}>
                            <div style={{padding:"5px 10px",background:"var(--a2)",border:"1px solid rgba(245,166,35,.22)",borderRadius:2}}>
                              <span className="mn" style={{fontSize:8,color:"var(--a)"}}>{g.ep}</span>
                            </div>
                          </div>
                        )}
                      </div>
                      <p style={{fontSize:12,color:"rgba(240,237,230,.65)",lineHeight:1.78,marginBottom:18,fontWeight:300,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical"}}>{g.bio}</p>
                      <div style={{borderTop:"1px solid var(--bdr)",paddingTop:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{flex:1,minWidth:0,paddingRight:12}}>
                          <div className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".09em",marginBottom:4}}>Episode</div>
                          <div style={{fontSize:11,color:"var(--c)",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ep.title}</div>
                          {ep.dur&&<div style={{fontSize:10,color:"var(--g)",marginTop:2}}>{ep.dur}</div>}
                        </div>
                        <div style={{display:"flex",gap:8,flexShrink:0}}>
                          {g._ep&&g._ep._storageMode&&onEditEpisode&&(
                            <button
                              onClick={()=>onEditEpisode(g._ep)}
                              title="Edit episode details"
                              style={{width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,.04)",border:"1px solid var(--bdr)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"var(--g)",transition:"all .25s"}}
                              onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--a)";e.currentTarget.style.color="var(--a)";}}
                              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.color="var(--g)";}}
                            >✏️</button>
                          )}
                          <button
                            onClick={()=>onPlay(ep)}
                            style={{width:40,height:40,borderRadius:"50%",background:isHov?"var(--a)":"var(--a2)",border:`1px solid rgba(245,166,35,${isHov?1:.22})`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:isHov?"#070707":"var(--a)",transition:"all .25s"}}
                          >▶</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </Rv>
              );
            })}
          </div>

          {/* ── Show More / Show Less button ──────────────────────── */}
          {allCards.length > VISIBLE_COUNT && (
            <div style={{textAlign:"center",marginTop:40}}>
              <button
                onClick={()=>setShowAll(v=>!v)}
                style={{
                  display:"inline-flex",alignItems:"center",gap:10,
                  padding:"14px 32px",
                  background:"transparent",
                  border:"1px solid var(--bdr)",
                  color:"var(--g)",
                  fontFamily:"'JetBrains Mono',monospace",
                  fontSize:10,letterSpacing:".1em",textTransform:"uppercase",
                  cursor:"pointer",
                  transition:"all .25s cubic-bezier(.16,1,.3,1)",
                  borderRadius:2,
                  position:"relative",overflow:"hidden",
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--a)";e.currentTarget.style.color="var(--a)";e.currentTarget.style.background="var(--a2)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.color="var(--g)";e.currentTarget.style.background="transparent";}}
              >
                {showAll
                  ? <><span style={{fontSize:13}}>↑</span> Show Less</>
                  : <><span style={{fontSize:13}}>+</span> {hiddenCount} More Guests</>
                }
              </button>
              {!showAll && (
                <p style={{marginTop:12,fontSize:11,color:"var(--g)",opacity:.5}}>
                  Showing {VISIBLE_COUNT} of {allCards.length} guests
                </p>
              )}
            </div>
          )}

        </div>
      </section>
    </div>
  );
}

function About() {
  return (
    <div style={{paddingTop:68}}>
      <section style={{position:"relative",minHeight:"520px",display:"flex",alignItems:"stretch",overflow:"hidden",background:"#040404"}}>
        <div style={{flex:"0 0 58%",position:"relative",display:"flex",flexDirection:"column",justifyContent:"center",padding:"80px var(--container-padding) 80px",zIndex:1}}>
          <div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:"linear-gradient(to bottom,var(--a),var(--r))"}} />
          <Rv><h1 className="bb" style={{fontSize:"clamp(52px,9vw,114px)",color:"var(--c)",lineHeight:.86,marginBottom:30}}>Where<br /><em className="sf" style={{color:"var(--a)"}}>Signal</em><br />Meets<br />Noise.</h1><div style={{borderLeft:"3px solid var(--a)",paddingLeft:20}}><p className="sf" style={{fontSize:"clamp(14px,2.5vw,18px)",color:"rgba(240,237,230,.65)",fontStyle:"italic",lineHeight:1.75,fontWeight:300}}>"We don't rush. We don't cut.<br />We let ideas breathe."</p><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".12em",marginTop:10}}>— JORDAN COLE, HOST</div></div></Rv>
        </div>
        <div style={{flex:"0 0 42%",position:"relative",overflow:"hidden"}}>
          <img src="https://images.unsplash.com/photo-1560250097-0b93528c311a?w=900&q=85" alt="Host" style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"top center",filter:"grayscale(.45) contrast(1.08)",opacity:.7}} />
          <div style={{position:"absolute",inset:0,background:"linear-gradient(to left,transparent 20%,rgba(4,4,4,.5) 60%,#040404 90%)"}} />
          <div style={{position:"absolute",bottom:28,left:28,right:28}}><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".14em",marginBottom:5}}>HOST & CREATOR</div><div className="bb" style={{fontSize:28,color:"var(--c)",lineHeight:1}}>Jordan Cole</div></div>
        </div>
      </section>
      <section className="sec" style={{background:"var(--d2)"}}>
        <div className="wrap" style={{maxWidth:700,margin:"0 auto"}}>
          <Rv><div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:16}}>// THE_STORY</div><h2 className="bb" style={{fontSize:"clamp(36px,5.5vw,72px)",color:"var(--c)",lineHeight:.91,marginBottom:26}}>A Show Built<br />for <em className="sf" style={{color:"var(--a)"}}>Depth.</em></h2><p style={{fontSize:15,color:"var(--g)",lineHeight:1.9,fontWeight:300,marginBottom:22}}>Signal & Noise is a weekly long-form interview podcast exploring the ideas, systems, and people shaping the world. Each episode is a deep, uncut conversation — no scripts, no soundbites.</p><p style={{fontSize:14,color:"var(--g)",lineHeight:1.9,fontWeight:300}}>We believe the best conversations happen when you slow down. That's why every episode runs 60–90 minutes. We don't rush. We don't cut. We let ideas breathe.</p></Rv>
        </div>
      </section>
    </div>
  );
}

function Subscribe() {
  const [email,setEmail]=useState(""),[done,setDone]=useState(false);
  return (
    <div style={{paddingTop:68}}>
      <section style={{position:"relative",minHeight:"400px",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",background:"#030303",textAlign:"center"}}>
        {[1,2,3,4,5].map(i=><div key={i} style={{position:"absolute",width:`${i*160}px`,height:`${i*160}px`,borderRadius:"50%",border:`1px solid rgba(245,166,35,${Math.max(0,.2-i*.04)})`,animation:`ripple ${1.8+i*.7}s ease-out infinite`,animationDelay:`${i*.45}s`,pointerEvents:"none"}} />)}
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 55% 65% at 50% 50%, transparent 25%, #030303 80%)",pointerEvents:"none"}} />
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,transparent,var(--a),var(--r),transparent)"}} />
        <div className="wrap" style={{position:"relative",zIndex:3,padding:"72px 0"}}>
          <Rv><h1 className="bb" style={{fontSize:"clamp(54px,10vw,124px)",color:"var(--c)",lineHeight:.86,marginBottom:22}}>Listen<br /><em className="sf" style={{color:"var(--a)"}}>Everywhere.</em></h1><p style={{fontSize:"clamp(13px,2.5vw,15px)",color:"var(--g)",maxWidth:"min(380px,90vw)",margin:"0 auto",fontWeight:300,lineHeight:1.85}}>Over 1 million people tune in monthly. Join on your platform of choice.</p></Rv>
        </div>
      </section>
      <section className="sec" style={{background:"var(--d2)"}}>
        <div className="wrap">
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:2,maxWidth:960,margin:"0 auto 80px"}}>
            {PLATFORMS.map((p,i)=><Rv key={p.name} delay={i*.06}><a href={p.url} target="_blank" rel="noopener noreferrer" style={{display:"flex",gap:18,alignItems:"center",padding:"24px 28px",background:"var(--card)",border:"1px solid var(--bdr)",textDecoration:"none",position:"relative",overflow:"hidden",transition:"all .28s cubic-bezier(.16,1,.3,1)"}} onMouseEnter={e=>{e.currentTarget.style.borderColor=p.color;e.currentTarget.style.background=`${p.color}10`;e.currentTarget.style.transform="translateY(-5px)"}} onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.background="var(--card)";e.currentTarget.style.transform="none"}}><div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:p.color,opacity:.7}} /><div style={{fontSize:34,flexShrink:0,marginLeft:8}}>{p.icon}</div><div style={{flex:1,minWidth:0}}><div style={{fontSize:16,fontWeight:700,color:"var(--c)",marginBottom:3}}>{p.name}</div><div className="mn" style={{fontSize:9,color:"var(--g)",letterSpacing:".07em"}}>{p.sub}</div></div><span style={{fontSize:16,color:"var(--g)",flexShrink:0}}>↗</span></a></Rv>)}
          </div>
          <Rv delay={.3}>
            <div style={{maxWidth:560,margin:"0 auto",padding:"52px 48px",background:"var(--card)",border:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--a),var(--r))"}} />
              <div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:12}}>// WEEKLY_NEWSLETTER</div>
              <h3 className="bb" style={{fontSize:"clamp(26px,4vw,38px)",color:"var(--c)",lineHeight:.95,marginBottom:10}}>Get the<br /><em className="sf" style={{color:"var(--a)"}}>Transcript + Links</em></h3>
              <p style={{fontSize:13,color:"var(--g)",marginBottom:28,lineHeight:1.78,fontWeight:300}}>Full transcript, reading list, and timestamps. Free every Friday.</p>
              {done?<div style={{textAlign:"center",padding:"24px 0"}}><div style={{fontSize:44,marginBottom:12,animation:"float 2s ease-in-out infinite"}}>✉️</div><div className="bb" style={{fontSize:24,color:"var(--a)",marginBottom:6,lineHeight:1}}>You're In!</div><p style={{color:"var(--g)",fontSize:13}}>First issue arrives this Friday.</p></div>
              :<div style={{display:"flex",gap:8,flexWrap:"wrap"}}><input type="email" className="field" placeholder="your@email.com" style={{flex:1,minWidth:180}} value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&email&&setDone(true)} /><button className="btn btn-a" onClick={()=>{if(email)setDone(true);}} style={{whiteSpace:"nowrap",padding:"12px 24px"}}>Subscribe →</button></div>}
            </div>
          </Rv>
        </div>
      </section>
    </div>
  );
}

function Contact() {
  const [tab,setTab]=useState("guest"),[sent,setSent]=useState(false);
  const submit=e=>{e.preventDefault();setSent(true);setTimeout(()=>setSent(false),4000);};
  return (
    <div style={{paddingTop:68}}>
      <section style={{position:"relative",minHeight:"320px",display:"flex",alignItems:"center",overflow:"hidden",background:"#060606"}}>
        <div style={{position:"absolute",inset:0,backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 23px,rgba(245,166,35,.025) 23px,rgba(245,166,35,.025) 24px)",pointerEvents:"none"}} />
        <div style={{position:"absolute",left:0,top:0,bottom:0,width:3,background:"linear-gradient(to bottom,var(--a),var(--r))"}} />
        <div className="wrap" style={{position:"relative",zIndex:1,padding:"60px 0"}}><Rv><h1 className="bb" style={{fontSize:"clamp(52px,10vw,116px)",color:"var(--c)",lineHeight:.88,marginBottom:22}}>Get In<br /><em className="sf" style={{color:"var(--a)"}}>Touch.</em></h1><p style={{fontSize:"clamp(13px,2.5vw,15px)",color:"var(--g)",maxWidth:"min(420px,90vw)",fontWeight:300,lineHeight:1.82}}>We're selective about who we bring on — but we're always listening.</p></Rv></div>
      </section>
      <section className="sec">
        <div className="wrap">
          <div style={{display:"grid",gridTemplateColumns:"1fr 480px",gap:72}} className="g2">
            <div><Rv><p style={{fontSize:15,color:"var(--g)",lineHeight:1.85,fontWeight:300,marginBottom:36}}>We're always looking for original minds. If you have something worth saying, reach out.</p>{[{l:"Guest Pitches",v:"guests@signalandnoise.fm"},{l:"Sponsorships",v:"sponsorship@signalandnoise.fm"},{l:"General",v:"hello@signalandnoise.fm"},{l:"Press",v:"press@signalandnoise.fm"}].map(c=><div key={c.l} style={{padding:"16px 0",borderBottom:"1px solid var(--bdr)"}}><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".1em",marginBottom:5,textTransform:"uppercase"}}>{c.l}</div><div style={{fontSize:14,color:"var(--c)",fontWeight:500}}>{c.v}</div></div>)}</Rv></div>
            <Rv delay={.14}>
              <div className="card" style={{overflow:"hidden"}}>
                <div style={{display:"flex",borderBottom:"1px solid var(--bdr)"}}>{[{id:"guest",l:"Pitch a Guest"},{id:"sponsor",l:"Sponsor"}].map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"14px",background:tab===t.id?"var(--a2)":"transparent",border:"none",borderRight:"1px solid var(--bdr)",color:tab===t.id?"var(--a)":"var(--g)",fontFamily:"'JetBrains Mono'",fontSize:9,letterSpacing:".1em",textTransform:"uppercase",cursor:"pointer",transition:"all .2s",borderBottom:tab===t.id?"2px solid var(--a)":"2px solid transparent"}}>{t.l}</button>)}</div>
                <form onSubmit={submit} style={{padding:"28px"}}>
                  {sent?<div style={{textAlign:"center",padding:"36px 0"}}><div style={{fontSize:44,marginBottom:14,animation:"float 2s ease-in-out infinite"}}>✉️</div><h3 className="sf" style={{fontSize:22,color:"var(--c)",marginBottom:7}}>Received!</h3><p style={{color:"var(--g)",fontSize:13}}>We'll be in touch within 5–7 business days.</p></div>
                  :<><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}><div><label className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:6,textTransform:"uppercase"}}>Name *</label><input required className="field" placeholder="Your name" /></div><div><label className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:6,textTransform:"uppercase"}}>Email *</label><input required type="email" className="field" placeholder="your@email.com" /></div></div><div style={{marginBottom:12}}><label className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:6,textTransform:"uppercase"}}>{tab==="guest"?"Guest Name & Role *":"Company *"}</label><input required className="field" placeholder={tab==="guest"?"Dr. Jane Smith — Stanford neuroscientist":"Your company name"} /></div><div style={{marginBottom:14}}><label className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".1em",display:"block",marginBottom:6,textTransform:"uppercase"}}>Message *</label><textarea required className="field" rows={4} placeholder={tab==="guest"?"What makes them uniquely qualified?":"Tell us about your product and goals"} style={{resize:"vertical"}} /></div><button type="submit" className="btn btn-a" style={{width:"100%",justifyContent:"center",padding:"14px"}}>Send Message →</button></>}
                </form>
              </div>
            </Rv>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── Reviews carousel ────────────────────────────────────────── */
const REVIEWS=[{name:"Sarah K.",text:"The best podcast I've discovered in years. Jordan asks the questions everyone else is afraid to.",platform:"Spotify"},{name:"Marc D.",text:"I listen on my morning commute and arrive at work feeling like I've had 3 coffees AND a philosophy lecture.",platform:"Apple Podcasts"},{name:"Ananya S.",text:"The Dr. Lembke episode literally changed how I use my phone. No exaggeration.",platform:"YouTube"},{name:"Tom B.",text:"1h 30m episodes and I still want more. That's the Jordan Cole effect.",platform:"Spotify"},{name:"Preethi V.",text:"Never thought a podcast could make me genuinely reconsider my career.",platform:"Apple Podcasts"},{name:"James W.",text:"The research that goes into each episode is insane. Every guest is perfectly chosen.",platform:"Amazon Music"}];

function ReviewsCarousel() {
  const allR=[...REVIEWS,...REVIEWS];
  return (
    <section className="sec-sm" style={{background:"var(--d2)",overflow:"hidden"}}>
      <div className="wrap" style={{marginBottom:36}}><Rv><div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:12}}><div><div className="mn" style={{fontSize:9,color:"var(--a)",letterSpacing:".14em",marginBottom:10}}>// LISTENER_REVIEWS</div><h2 className="bb" style={{fontSize:"clamp(38px,5vw,60px)",color:"var(--c)",lineHeight:.92}}>What People<br /><em className="sf" style={{color:"var(--a)"}}>Are Saying</em></h2></div><div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}><div className="bb" style={{fontSize:52,color:"var(--a)",lineHeight:1}}>4.9</div><div style={{display:"flex",gap:3}}>{"★★★★★".split("").map((s,i)=><span key={i} style={{color:"var(--a)",fontSize:14}}>{s}</span>)}</div><div className="mn" style={{fontSize:9,color:"var(--g)"}}>14,200+ reviews</div></div></div></Rv></div>
      <div style={{overflow:"hidden",position:"relative"}}>
        <div style={{position:"absolute",left:0,top:0,bottom:0,width:80,background:"linear-gradient(to right,var(--d2),transparent)",zIndex:2,pointerEvents:"none"}} />
        <div style={{position:"absolute",right:0,top:0,bottom:0,width:80,background:"linear-gradient(to left,var(--d2),transparent)",zIndex:2,pointerEvents:"none"}} />
        <div className="review-track">
          {allR.map((r,i)=><div key={i} style={{flexShrink:0,width:300,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:2,padding:"20px",marginRight:12,whiteSpace:"normal",wordBreak:"break-word",boxSizing:"border-box"}}><div style={{display:"flex",gap:3,marginBottom:10}}>{"★★★★★".split("").map((_,j)=><span key={j} style={{color:"var(--a)",fontSize:13}}>★</span>)}</div><p style={{fontSize:12,color:"var(--g)",lineHeight:1.7,marginBottom:14,fontStyle:"italic",wordWrap:"break-word",overflowWrap:"break-word",whiteSpace:"normal"}}>"{r.text}"</p><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:11,fontWeight:600,color:"var(--c)"}}>{r.name}</span><span className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".07em"}}>{r.platform}</span></div></div>)}
        </div>
      </div>
    </section>
  );
}

/* ── Footer ──────────────────────────────────────────────────── */
function Footer({ nav }) {
  return (
    <footer style={{background:"#030303",borderTop:"1px solid var(--bdr)",padding:"68px 0 28px"}}>
      <div className="wrap">
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:"clamp(20px,4vw,44px)",marginBottom:60}}>
          <div><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}><WaveBars count={5} height={16} /><span className="bb" style={{fontSize:20,color:"var(--c)",letterSpacing:".06em"}}>Signal & Noise</span></div><p style={{fontSize:12,color:"var(--g)",lineHeight:1.8,maxWidth:260,fontWeight:300,marginBottom:20}}>The podcast that asks the questions nobody else is asking — and gives ideas room to breathe.</p></div>
          {[
            {t:"Navigate",items:[{to:"home",l:"Home",href:null},{to:"episodes",l:"Episodes",href:null},{to:"guests",l:"Guests",href:null},{to:"about",l:"About",href:null}]},
            {t:"Connect",items:[{to:null,l:"Spotify",href:"https://open.spotify.com"},{to:null,l:"Apple Podcasts",href:"https://podcasts.apple.com"},{to:null,l:"YouTube",href:"https://youtube.com"},{to:null,l:"RSS Feed",href:"https://signalandnoise.fm/feed"}]},
            {t:"More",items:[{to:"contact",l:"Contact",href:null},{to:"subscribe",l:"Newsletter",href:null},{to:"contact",l:"Advertise",href:null},{to:"about",l:"Press",href:null}]}
          ].map(col=><div key={col.t}><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".14em",marginBottom:14,textTransform:"uppercase"}}>{col.t}</div><div style={{display:"flex",flexDirection:"column",gap:9}}>{col.items.map(({to,l,href})=>href?<a key={l} href={href} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:"var(--g)",transition:"color .2s",fontFamily:"'DM Sans'",textDecoration:"none",display:"block"}} onMouseEnter={e=>e.target.style.color="var(--c)"} onMouseLeave={e=>e.target.style.color="var(--g)"}>{l}</a>:<button key={l} onClick={()=>nav(to)} style={{background:"none",border:"none",cursor:"pointer",textAlign:"left",fontSize:12,color:"var(--g)",transition:"color .2s",fontFamily:"'DM Sans'"}} onMouseEnter={e=>e.target.style.color="var(--c)"} onMouseLeave={e=>e.target.style.color="var(--g)"}>{l}</button>)}</div></div>)}
        </div>
        <div style={{borderTop:"1px solid var(--bdr)",paddingTop:24,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
          <span className="mn" style={{fontSize:9,color:"var(--g)",letterSpacing:".06em"}}>© 2026 Signal & Noise. All rights reserved.</span>
          <span className="mn" style={{fontSize:9,color:"var(--g)",letterSpacing:".06em"}}>Made with obsession ◆ Season 3</span>
        </div>
      </div>
    </footer>
  );
}

/* ═══════════════════════════════════════════════════════════════
   NEWSLETTER POPUP
   ═══════════════════════════════════════════════════════════════ */
function NewsletterPopup({ onClose }) {
  const [email,setEmail]=useState(""),[done,setDone]=useState(false);
  const submit=e=>{e.preventDefault();if(!email)return;setDone(true);setTimeout(onClose,3200);};
  return (
    <div className="nl-popup">
      <button onClick={onClose} style={{position:"absolute",top:10,right:14,background:"none",border:"none",cursor:"pointer",color:"var(--g)",fontSize:16,lineHeight:1}}>✕</button>
      {done?<div style={{textAlign:"center",padding:"12px 0"}}><div style={{fontSize:36,marginBottom:10,animation:"float 2s ease-in-out infinite"}}>🎧</div><p style={{fontWeight:700,color:"var(--c)",marginBottom:4}}>You're in the loop!</p><p style={{fontSize:12,color:"var(--g)"}}>First issue arrives Friday.</p></div>
      :<><div className="mn" style={{fontSize:8,color:"var(--a)",letterSpacing:".12em",marginBottom:10}}>// WEEKLY DIGEST</div><h4 style={{fontSize:15,fontWeight:700,color:"var(--c)",marginBottom:5,lineHeight:1.4}}>Get every episode<br />in your inbox</h4><p style={{fontSize:11,color:"var(--g)",marginBottom:16,lineHeight:1.65}}>Transcript · Reading list · Timestamps. Every Friday. Free.</p><form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:9}}><input type="email" required className="field" placeholder="your@email.com" style={{fontSize:12,padding:"10px 14px"}} value={email} onChange={e=>setEmail(e.target.value)} /><button type="submit" className="btn btn-a" style={{padding:"11px",justifyContent:"center",width:"100%",fontSize:10}}>Subscribe Free →</button></form><p className="mn" style={{fontSize:8,color:"var(--g)",marginTop:10,textAlign:"center",letterSpacing:".06em"}}>No spam. Unsubscribe anytime.</p></>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════ */
export default function App() {
  const [page,      setPage]      = useState("home");
  const [data,      setData]      = useState(null);
  const [playing,   setPlaying]   = useState(null);
  const [videoPlaying,setVideoPlaying]=useState(null);
  const [darkMode,  setDarkMode]  = useState(true);
  const [showSearch,setShowSearch]= useState(false);
  const [newsletter,setNewsletter]= useState(false);
  const [toast,     setToast]     = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [uploadedEps,setUploadedEps]=useState([]);
  const [serverOnline,setServerOnline]=useState(false);
  const [idbReady,  setIdbReady]  = useState(false);
  const [editingEp,  setEditingEp]  = useState(null);

  /* ── CSS injection ───────────────────────────────────────── */
  useEffect(()=>{
    let el=document.getElementById("sn-css");
    if(!el){el=document.createElement("style");el.id="sn-css";document.head.prepend(el);}
    el.textContent=CSS;
  },[]);

  /* ── Check server availability ───────────────────────────── */
  useEffect(()=>{
    let mounted=true;
    const check=async()=>{
      const online=await checkServerOnline();
      if(mounted)setServerOnline(online);
    };
    check();
    const interval=setInterval(check,30_000); // re-check every 30s
    return()=>{mounted=false;clearInterval(interval);};
  },[]);

  /* ── Load episodes: cloud first, then local fallback ─────── */
  useEffect(()=>{
    let mounted=true;
    const load=async()=>{
      // 1. Load from localStorage + IDB (fast, works offline)
      const localEps=await loadEpisodesFromLocal();
      if(mounted&&localEps.length>0)setUploadedEps(localEps);

      // 2. Try cloud (server episodes.json)
      const cloudEps=await cloudFetchEpisodes();
      if(mounted&&cloudEps){
        const merged=mergeEpisodeLists(cloudEps,localEps);
        setUploadedEps(merged);
        // Sync merged metadata back to localStorage
        saveEpisodesToLocalStorage(merged);
      }
      if(mounted)setIdbReady(true);
    };
    load().catch(()=>{if(mounted)setIdbReady(true);});
    return()=>{mounted=false;};
  },[]);

  /* ── Persist to localStorage whenever uploadedEps changes ── */
  useEffect(()=>{
    if(idbReady)saveEpisodesToLocalStorage(uploadedEps);
  },[uploadedEps,idbReady]);

  /* ── Dark mode body class ────────────────────────────────── */
  useEffect(()=>{ document.body.classList.toggle("light",!darkMode); },[darkMode]);

  /* ── Player-active body class (for btt + newsletter offset) ─ */
  useEffect(()=>{ document.body.classList.toggle("player-active",!!playing); },[playing]);

  /* ── Newsletter popup ────────────────────────────────────── */
  useEffect(()=>{ const t=setTimeout(()=>setNewsletter(true),18000); return()=>clearTimeout(t); },[]);

  /* ── Keyboard shortcuts ──────────────────────────────────── */
  useEffect(()=>{
    let buf="",bufT=null;
    const handler=e=>{
      const tag=document.activeElement.tagName;
      if(tag==="INPUT"||tag==="TEXTAREA")return;
      if(e.key==="Escape"){setShowSearch(false);return;}
      if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();setShowSearch(true);return;}
      buf+=e.key.toLowerCase();clearTimeout(bufT);bufT=setTimeout(()=>{buf="";},800);
      if(buf.endsWith("gh")){nav("home");buf="";}
      if(buf.endsWith("ge")){nav("episodes");buf="";}
      if(buf.endsWith("gg")){nav("guests");buf="";}
      if(buf.endsWith("ga")){nav("about");buf="";}
      if(buf.endsWith("gu")){nav("upload");buf="";}
    };
    window.addEventListener("keydown",handler);
    return()=>window.removeEventListener("keydown",handler);
  },[]);

  /* ── Scroll reset on page change ─────────────────────────── */
  useEffect(()=>{
    setLoading(true);
    window.scrollTo({top:0,behavior:"smooth"});
    const t=setTimeout(()=>setLoading(false),300);
    return()=>clearTimeout(t);
  },[page]);

  const nav=useCallback((p,d=null)=>{setPage(p);setData(d);},[]);
  const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(null),2800);};

  /* ── Episode added callback ──────────────────────────────── */
  const handleEpisodeAdded=useCallback(ep=>{
    setUploadedEps(prev=>[ep,...prev]);
    showToast(`${ep.mediaType==="video"?"🎬":ep.mediaType==="song"?"🎵":"🎙"} Added: ${ep.title}`);
  },[]);

  /* ── Episode deleted callback ────────────────────────────── */
  const handleDeleteEpisode=useCallback(id=>{
    setUploadedEps(prev=>{
      const ep=prev.find(e=>e.id===id);
      if(ep?.audioUrl?.startsWith("blob:"))URL.revokeObjectURL(ep.audioUrl);
      if(ep?.videoUrl?.startsWith("blob:"))URL.revokeObjectURL(ep.videoUrl);
      if(ep?._blobUrl)URL.revokeObjectURL(ep._blobUrl);
      return prev.filter(e=>e.id!==id);
    });
    deleteFileFromIDB(id).catch(()=>{});
    if(serverOnline)cloudDeleteEpisode(id).catch(()=>{});
    showToast("Episode removed.");
  },[serverOnline]);

  /* ── Episode edited callback ─────────────────────────────── */
  const handleEditEpisode=useCallback(updatedEp=>{
    setUploadedEps(prev=>prev.map(e=>e.id===updatedEp.id?updatedEp:e));
    cloudSaveEpisodeMeta(updatedEp).catch(()=>{});
    showToast(`✏️ Saved: ${updatedEp.title}`);
  },[]);

  /* ── Play handler ────────────────────────────────────────── */
  const handlePlay=ep=>{
    if(ep.mediaType==="video"&&(ep.videoUrl||ep.cloudVideoUrl)){
      setPlaying(null);       // stop audio player first
      setVideoPlaying(ep);
      showToast(`🎬 Playing: ${ep.title}`);
    } else {
      setVideoPlaying(null);  // stop video player first
      setPlaying(ep);
      showToast(`▶ Now playing: ${ep.num||""}${ep.num?" — ":""}${ep.guest||ep.title}`);
    }
  };

  /* ── Pages map ───────────────────────────────────────────── */
  const VIEWS={
    home:     <Home      nav={nav} onPlay={handlePlay} uploadedEps={uploadedEps} />,
    episodes: <Episodes  nav={nav} onPlay={handlePlay} uploadedEps={uploadedEps} loading={loading} />,
    episode:  <EpisodeDetail ep={data||[...uploadedEps,...EPS][0]} onPlay={handlePlay} />,
    guests:   <Guests    onPlay={handlePlay} uploadedEps={uploadedEps} onEditEpisode={ep=>setEditingEp(ep)} />,
    about:    <About />,
    subscribe:<Subscribe />,
    contact:  <Contact />,
    upload:   <Upload    onEpisodeAdded={handleEpisodeAdded} uploadedEps={uploadedEps} onDeleteEpisode={handleDeleteEpisode} serverOnline={serverOnline} />,
  };

  return (
    <div style={{minHeight:"100vh",background:"var(--d)"}}>
      <NavbarV2 page={page} nav={nav} onSearch={()=>setShowSearch(true)} darkMode={darkMode} toggleDark={()=>setDarkMode(v=>!v)} serverOnline={serverOnline} />

      <main key={page} style={{ paddingBottom:playing?130:0, transition:"padding-bottom .4s", animation:"fadeIn .38s ease" }}>
        {loading?(
          <div style={{paddingTop:160,display:"flex",justifyContent:"center"}}>
            <div style={{display:"flex",gap:5,alignItems:"flex-end"}}>{[1,.6,1,.5,.9].map((h,i)=><div key={i} className="wb" style={{height:`${20*h}px`,animationDelay:`${i*.09}s`}} />)}</div>
          </div>
        ):VIEWS[page]||VIEWS.home}
      </main>

      {page==="home"&&!loading&&<ReviewsCarousel />}
      <Footer nav={nav} />

      {/* ── Player bar ────────────────────────────────────────── */}
      {playing && <PlayerBar ep={playing} onClose={()=>setPlaying(null)} />}

      {/* ── Video modal ────────────────────────────────────────── */}
      {videoPlaying && <VideoPlayerModal ep={videoPlaying} onClose={()=>setVideoPlaying(null)} allEps={[...uploadedEps,...EPS]} />}

      {/* ── Search overlay ────────────────────────────────────── */}
      {showSearch && <SearchOverlay onClose={()=>setShowSearch(false)} nav={nav} onPlay={handlePlay} uploadedEps={uploadedEps} />}

      {/* ── Newsletter popup ──────────────────────────────────── */}
      {newsletter && <NewsletterPopup onClose={()=>setNewsletter(false)} />}

      {/* ── Edit episode modal ─────────────────────────────────── */}
      {editingEp && <EditEpisodeModal ep={editingEp} onSave={handleEditEpisode} onClose={()=>setEditingEp(null)} />}

      {/* ── Toast ─────────────────────────────────────────────── */}
      {toast && <Toast msg={toast} onDone={()=>setToast(null)} />}

      {/* ── Back to top ───────────────────────────────────────── */}
      <BackToTop />

      {/* ── Keyboard shortcut hint ────────────────────────────── */}
      <div className="kbd-hint" style={{position:"fixed",bottom:28,left:28,zIndex:700,display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:"rgba(255,255,255,.04)",border:"1px solid var(--bdr)",borderRadius:2,transition:"all .2s"}} onMouseEnter={e=>e.currentTarget.style.borderColor="var(--a)"} onMouseLeave={e=>e.currentTarget.style.borderColor="var(--bdr)"}>
        <span className="kbd">⌘K</span>
        <span className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".08em"}}>search</span>
        <span className="kbd" style={{marginLeft:4}}>Gh</span>
        <span className="mn" style={{fontSize:8,color:"var(--g)",letterSpacing:".08em"}}>home</span>
      </div>
    </div>
  );
}
