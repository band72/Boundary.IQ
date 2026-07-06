import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { aiChat } from '../services/chatService.js';
import { runRepairPipeline } from '../services/Scripting/repair.js';
import { generateDxf, generateCombinedDxf } from '../services/dxfExport.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (_req, file, cb) => cb(null, `chat_${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// All chat routes require authentication
router.use(requireAuth);

router.post('/message', upload.single('image'), asyncHandler(async (req, res) => {
  let { message, history } = req.body;
  const imageFile = req.file;
  
  if (typeof history === 'string') {
    try {
      history = JSON.parse(history);
    } catch (err) {
      history = [];
    }
  } else if (!Array.isArray(history)) {
    history = [];
  }

  // 1. Get AI conversational response
  const aiResponse = await aiChat(message, history, imageFile?.path || null);

  // 2. Best-effort visual/COGO extraction if image was attached
  let pipelineResult = null;
  if (imageFile) {
    try {
      const result = await runRepairPipeline(
        fs.readFileSync(imageFile.path),
        imageFile.mimetype || 'image/jpeg',
        { northing: 5000, easting: 5000 },
        'Feet',
        false, // isOpenEnded
        imageFile.path // fileName
      );

      if (result) {
        const stations = result.finalTraverse?.stations || [];
        const adjusted = result.finalTraverse?.adjustedStations || [];
        const courses = result.finalExtraction?.courses || [];
        
        let dxfContent = '';
        if (result.finalExtraction?.parcels && result.finalExtraction.parcels.length > 0) {
          dxfContent = generateCombinedDxf(result.finalExtraction.parcels);
        } else if (stations.length > 0) {
          dxfContent = generateDxf(stations, adjusted, courses, {
            jobName: 'ChatExtract',
            units: 'Feet'
          }, result.bustCourseIndex);
        }

        pipelineResult = {
          points: adjusted.length > 0 ? adjusted : (stations.length > 0 ? stations : []),
          closure: result.finalTraverse?.closure || null,
          dxfContent: dxfContent || null
        };
      }
    } catch (err) {
      console.warn('[ChatRoute] Best-effort plat extraction failed:', err.message);
    }
  }

  res.json({
    response: aiResponse,
    pipelineResult,
    imageUrl: imageFile ? `/uploads/${path.basename(imageFile.path)}` : null
  });
}));

export default router;
