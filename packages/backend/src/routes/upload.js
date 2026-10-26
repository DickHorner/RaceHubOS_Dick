import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Ensure upload directories exist
const uploadDirs = ['drivers', 'cars', 'tracks', 'teams'];
uploadDirs.forEach((dir) => {
  const dirPath = path.join(__dirname, '../../public/uploads', dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.params.type || 'misc';
    const validTypes = ['drivers', 'cars', 'tracks', 'teams'];
    const folder = validTypes.includes(type) ? type : 'misc';
    const uploadPath = path.join(__dirname, '../../public/uploads', folder);

    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

// File filter for images only
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
});

// Soundboard audio uses a separate bounded upload path; image uploads remain unchanged.
const soundsDir = path.join(__dirname, '../../public/uploads/sounds');
fs.mkdirSync(soundsDir, { recursive: true });
const soundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const SOUND_FILENAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(mp3|ogg|wav)$/;
const SOUND_MIME = {
  '.mp3': ['audio/mpeg', 'audio/mp3'],
  '.ogg': ['audio/ogg', 'application/ogg'],
  '.wav': ['audio/wav', 'audio/x-wav', 'audio/wave'],
};

function soundExtension(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!SOUND_MIME[ext]?.includes(file.mimetype)) return null;
  const data = file.buffer;
  if (data.length < 12) return null;
  if (ext === '.wav' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return ext;
  if (ext === '.ogg' && data.toString('ascii', 0, 4) === 'OggS') return ext;
  if (ext === '.mp3' && (data.toString('ascii', 0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)))
    return ext;
  return null;
}

router.post('/sounds', soundUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No audio file uploaded' });
  const ext = soundExtension(req.file);
  if (!ext) return res.status(400).json({ success: false, error: 'Only valid MP3, OGG and WAV files are allowed' });

  try {
    if (fs.readdirSync(soundsDir).filter((name) => SOUND_FILENAME.test(name)).length >= 32) {
      return res.status(400).json({ success: false, error: 'Sound library limit (32 files) reached' });
    }
    const filename = randomUUID() + ext;
    await fs.promises.writeFile(path.join(soundsDir, filename), req.file.buffer, { flag: 'wx' });
    res.json({ success: true, data: { url: `/api/upload/sounds/${filename}`, filename } });
  } catch (error) {
    console.error('Sound upload error:', error);
    res.status(500).json({ success: false, error: 'Unable to save audio file' });
  }
});

router.get('/sounds/:filename', (req, res) => {
  const { filename } = req.params;
  if (!SOUND_FILENAME.test(filename)) return res.status(400).json({ success: false, error: 'Invalid sound filename' });
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(path.extname(filename));
  res.sendFile(path.join(soundsDir, filename), (error) => {
    if (error && !res.headersSent) res.status(404).json({ success: false, error: 'Sound not found' });
  });
});

router.delete('/sounds/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!SOUND_FILENAME.test(filename)) return res.status(400).json({ success: false, error: 'Invalid sound filename' });
  try {
    await fs.promises.unlink(path.join(soundsDir, filename));
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ success: false, error: 'Sound not found' });
    res.status(500).json({ success: false, error: 'Unable to delete audio file' });
  }
});

/**
 * POST /api/upload/:type
 * Upload an image for drivers, cars, or tracks
 * Returns the URL path to access the image
 */
router.post('/:type', upload.single('img'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    const type = req.params.type;
    const photoUrl = `/api/img/${type}/${req.file.filename}`;

    res.json({
      success: true,
      data: {
        url: photoUrl,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/upload/:type/:filename
 * Delete an uploaded image
 */
router.delete('/:type/:filename', (req, res) => {
  try {
    const { type, filename } = req.params;
    const validTypes = ['drivers', 'cars', 'tracks', 'teams'];

    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type',
      });
    }

    const filePath = path.join(__dirname, '../../public/uploads', type, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({
        success: true,
        message: 'File deleted',
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'File not found',
      });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Error handler for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 5MB',
      });
    }
    if (req.path === '/sounds') return res.status(400).json({ success: false, error: 'Invalid audio upload' });
  }
  res.status(500).json({
    success: false,
    error: error.message,
  });
});

export default router;
