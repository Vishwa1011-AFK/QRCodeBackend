const express = require('express');
const { signQRCodeBatch, scanQRCodeUnified, downloadBatchZip, getScanHistory } = require('../controllers/productController');
const router = express.Router();

// Route for signing a batch of QR codes and generating a master QR code
router.post('/sign', signQRCodeBatch);

// Route for scanning individual product or master QR codes
router.post('/scan', scanQRCodeUnified);

router.get('/batch/:batchId/download', downloadBatchZip);

router.get('/api/scan-history', getScanHistory);


module.exports = router;
