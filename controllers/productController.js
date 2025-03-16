require('dotenv').config();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const archiver = require('archiver');
const Product = require('../models/product');
const Scan = require('../models/scan');
const MasterQRCode = require('../models/masterQRCode');
const SellerScan = require('../models/sellerScan');
const fetch = require('node-fetch');
const crypto = require('crypto');

const SECRET_KEY = process.env.AES_SECRET_KEY;
const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY;
const HMAC_SECRET_KEY = process.env.HMAC_SECRET_KEY;
const IV_LENGTH = 16;

// Helper functions for encryption and HMAC
function encrypt(text, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  let encrypted = cipher.update(text);

  encrypted = Buffer.concat([encrypted, cipher.final()]);

  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text, key) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
  let decrypted = decipher.update(encryptedText);

  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString();
}

function generateHMAC(data, key) {
  const hmac = crypto.createHmac('sha256', key); // Or another strong hash algorithm
  hmac.update(data);
  return hmac.digest('hex');
}

function verifyHMAC(data, hmac, key) {
  const expectedHmac = generateHMAC(data, key);
  return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expectedHmac, 'hex'));
}

// Add new endpoint for downloading ZIP file
const downloadBatchZip = async (req, res) => {
    const { batchId } = req.params;
    try {
        const products = await Product.find({ batchId });
        if (products.length === 0) {
            return res.status(404).json({ error: 'No products found for this batch' });
        }

        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const imagePaths = [];
        for (const product of products) {
            const filePath = path.join(tempDir, `${product.uuid}.png`);
            // Use the stored JSON string directly (contains both token and hmac)
            await QRCode.toFile(filePath, product.signedQRCode); // CHANGED HERE
            imagePaths.push(filePath);
        }

        const masterQRCode = await MasterQRCode.findOne({ batchId });
        let masterFilePath;
        if (masterQRCode) {
            masterFilePath = path.join(tempDir, `master-${batchId}.png`);
            // Use the stored JSON string directly (contains both token and hmac)
            await QRCode.toFile(masterFilePath, masterQRCode.masterQRCode); // CHANGED HERE
            imagePaths.push(masterFilePath);
        }

        const zipFilePath = path.join(tempDir, `batch-${batchId}.zip`);
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(output);
        imagePaths.forEach((filePath) => {
            archive.file(filePath, { name: path.basename(filePath) });
        });
        await archive.finalize();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=batch-${batchId}.zip`);
        const fileStream = fs.createReadStream(zipFilePath);
        fileStream.pipe(res);

        const cleanup = () => {
            imagePaths.forEach((filePath) => {
                try {
                    fs.unlinkSync(filePath);
                } catch (err) {
                    console.error('Error deleting file:', err);
                }
            });
            try {
                fs.unlinkSync(zipFilePath);
            } catch (err) {
                console.error('Error deleting ZIP file:', err);
            }
        };

        fileStream.on('close', cleanup);
        fileStream.on('error', (err) => {
            console.error('File stream error:', err);
            cleanup();
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error sending ZIP file' });
            }
        });

    } catch (error) {
        console.error('Error generating batch ZIP:', error);
        // Cleanup on error before stream
        const tempDir = path.join(__dirname, '../temp');
        const zipFilePath = path.join(tempDir, `batch-${batchId}.zip`);
        imagePaths.forEach((filePath) => {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (err) {
                console.error('Error deleting file:', err);
            }
        });
        if (fs.existsSync(zipFilePath)) {
            try {
                fs.unlinkSync(zipFilePath);
            } catch (err) {
                console.error('Error deleting ZIP file:', err);
            }
        }
        res.status(500).json({ error: 'Error generating batch ZIP file' });
    }
};

const signQRCodeBatch = async (req, res) => {
    const { name, stationId, numberOfCodes, page = 1, limit = 20, batchId: existingBatchId } = req.body;
    let batchId = existingBatchId || uuidv4();
    let totalNumberOfCodes = numberOfCodes;
    let isNewBatch = false;

    try {
        // Check if batch exists
        let masterQR = await MasterQRCode.findOne({ batchId });
        if (masterQR) {
            totalNumberOfCodes = masterQR.totalNumberOfCodes;
        } else {
            isNewBatch = true;
            // Create master QR code data
            const masterQRData = { batchId };
            const encryptedMasterQRData = encrypt(JSON.stringify(masterQRData), SECRET_KEY);
            const masterQRCodeToken = jwt.sign({ data: encryptedMasterQRData }, JWT_SECRET_KEY, { expiresIn: '1y' });
            const hmac = generateHMAC(masterQRCodeToken, HMAC_SECRET_KEY);
            const fullMasterQRCodeData = { token: masterQRCodeToken, hmac };

            // Create new master QR code record
            masterQR = new MasterQRCode({
                batchId,
                masterQRCode: JSON.stringify(fullMasterQRCodeData),
                totalNumberOfCodes,
            });
            await masterQR.save();
        }

        // Calculate existing products and effective limit
        const existingCount = await Product.countDocuments({ batchId });
        const remaining = totalNumberOfCodes - existingCount;
        const effectiveLimit = Math.min(limit, remaining);

        if (effectiveLimit <= 0) {
            return res.status(400).json({ error: 'Batch already completed' });
        }

        // Generate new products
        const signedQRCodes = [];
        for (let i = 0; i < effectiveLimit; i++) {
            const uuid = uuidv4();
            const qrData = { name, stationId, uuid };
            const encryptedQrData = encrypt(JSON.stringify(qrData), SECRET_KEY);
            const signedQRCode = jwt.sign({ data: encryptedQrData }, JWT_SECRET_KEY, { expiresIn: '1y' });
            const hmac = generateHMAC(signedQRCode, HMAC_SECRET_KEY);
            const fullQRCodeData = { token: signedQRCode, hmac };

            const newProduct = new Product({
                name,
                stationId,
                uuid,
                signedQRCode: JSON.stringify(fullQRCodeData),
                batchId,
                createdAt: new Date(),
            });
            await newProduct.save();
            signedQRCodes.push(JSON.stringify(fullQRCodeData));
        }

        res.json({
            message: `${effectiveLimit} QR codes signed and stored successfully`,
            signedQRCodes,
            masterQRCode: isNewBatch ? masterQR.masterQRCode : undefined,
            batchId,
            total: totalNumberOfCodes,
            page,
            pages: Math.ceil(totalNumberOfCodes / limit),
        });

    } catch (error) {
        console.error('Error signing QR codes:', error);
        res.status(500).json({ error: 'Error signing QR codes' });
    }
};

const fetchLocationName = async (latitude, longitude) => {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data.display_name || 'Location Name Not Found';
    } catch (error) {
      console.error('Error fetching location name:', error);
      return 'Error Fetching Location';
    }
};

const scanQRCodeUnified = async (req, res) => {
    const { signedQRCode, location } = req.body;

    try {
        const qrCodeData = JSON.parse(signedQRCode);
        const { token, hmac } = qrCodeData;

        if (!verifyHMAC(token, hmac, HMAC_SECRET_KEY)) {
            return res.status(400).json({ error: 'Invalid QR code: HMAC verification failed' });
        }

        const decodedToken = jwt.verify(token, JWT_SECRET_KEY);
        const encryptedQrData = decodedToken.data;
        const decryptedQrData = decrypt(encryptedQrData, SECRET_KEY);
        const qrData = JSON.parse(decryptedQrData);

        if (qrData.batchId && !qrData.uuid) {
            // This is a master QR code
            const { batchId } = qrData;

            const products = await Product.find({ batchId });
            if (products.length === 0) {
                return res.status(404).json({ error: 'No products found for this batch' });
            }

             const { latitude, longitude } = location;
             const locationName = await fetchLocationName(latitude,longitude)
            const scanEntries = products.map(product => ({
                productId: product._id,
                location: { latitude, longitude },
                locationName : locationName,
            }));

             await Scan.insertMany(scanEntries);

            // Return batch data in the expected format
            return res.json({
                batch: {
                    batchId: batchId,
                    products: products.map(product => ({
                        name: product.name,
                        stationId: product.stationId,
                        uuid: product.uuid
                    }))
                }
            });
        }

        if (qrData.uuid) {
            // This is an individual product QR code
            const product = await Product.findOne({ uuid: qrData.uuid });
            if (!product) {
                return res.status(404).json({ error: 'Product not found' });
            }
           const { latitude, longitude } = location;
          const locationName = await fetchLocationName(latitude,longitude)

            const scan = new Scan({
                productId: product._id,
                location,
                 locationName : locationName,
            });
            await scan.save();

            return res.json({ product });
        }

        res.status(400).json({ error: 'Unrecognized QR code type' });
    } catch (error) {
        console.error('Error verifying QR code:', error);
        res.status(400).json({ error: 'Invalid or expired QR code' });
    }
};

const scanQRCodeSeller = async (req, res) => {
    const { signedQRCode, location } = req.body;
      try {
         const qrCodeData = JSON.parse(signedQRCode);
          const { token, hmac } = qrCodeData;

        if (!verifyHMAC(token, hmac, HMAC_SECRET_KEY)) {
            return res.status(400).json({ error: 'Invalid QR code: HMAC verification failed' });
        }

        const decodedToken = jwt.verify(token, JWT_SECRET_KEY);
        const encryptedQrData = decodedToken.data;
        const decryptedQrData = decrypt(encryptedQrData, SECRET_KEY);
        const qrData = JSON.parse(decryptedQrData);

        if (qrData.batchId && !qrData.uuid) {
            // This is a master QR code
            const { batchId } = qrData;

            const products = await Product.find({ batchId });
            if (products.length === 0) {
                return res.status(404).json({ error: 'No products found for this batch' });
            }

            const { latitude, longitude } = location;
              const locationName = await fetchLocationName(latitude,longitude)
            const sellerScanEntries = products.map(product => ({
                productId: product._id,
                location: { latitude, longitude },
               locationName: locationName
            }));

            await SellerScan.insertMany(sellerScanEntries);

            return res.json({
                batch: {
                    batchId: batchId,
                    products: products.map(product => ({
                        name: product.name,
                        stationId: product.stationId,
                        uuid: product.uuid
                    }))
                }
            });
        }

        if (qrData.uuid) {
            // This is an individual product QR code
            const product = await Product.findOne({ uuid: qrData.uuid });
            if (!product) {
                return res.status(404).json({ error: 'Product not found' });
            }
              const { latitude, longitude } = location;
             const locationName = await fetchLocationName(latitude,longitude)
            const sellerScan = new SellerScan({
                productId: product._id,
                location,
               locationName : locationName,
            });
            await sellerScan.save();

            return res.json({ product });
        }

        res.status(400).json({ error: 'Unrecognized QR code type' });
    } catch (error) {
        console.error('Error verifying QR code:', error);
        res.status(400).json({ error: 'Invalid or expired QR code' });
    }
};

const getScanHistory = async (req, res) => {
    const { signedQRCode } = req.query;
    try {
       const qrCodeData = JSON.parse(signedQRCode);
        const { token, hmac } = qrCodeData;

        if (!verifyHMAC(token, hmac, HMAC_SECRET_KEY)) {
            return res.status(400).json({ error: 'Invalid QR code: HMAC verification failed' });
        }

        const decodedToken = jwt.verify(token, JWT_SECRET_KEY);
        const encryptedQrData = decodedToken.data;
        const decryptedQrData = decrypt(encryptedQrData, SECRET_KEY);
        const qrData = JSON.parse(decryptedQrData);
        // First try to find if it's a master QR code
        const masterQR = await MasterQRCode.findOne({
            batchId: qrData.batchId
        }).lean();

        if (masterQR) {
            // If master QR, get all products in batch
            const products = await Product.find({
                batchId: masterQR.batchId
            }).lean();

            const productsWithScans = await Promise.all(products.map(async (product) => {
                const scans = await SellerScan.find({ productId: product._id })
                    .sort('-scannedAt')
                    .lean();

                return {
                    ...product,
                     scans: scans.map(scan => ({
                              location: scan.location,
                            scannedAt: scan.scannedAt,
                             locationName: scan.locationName
                        }))

                };
            }));

            return res.json({
                type: 'batch',
                data: {
                    batchId: masterQR.batchId,
                    createdAt: masterQR.createdAt,
                    scanRecords: masterQR.scanRecords,
                    products: productsWithScans
                }
            });
        }

        // If not master QR, look for individual product
        const product = await Product.findOne({
            uuid: qrData.uuid
        }).lean();

        if (product) {
            const scans = await SellerScan.find({
                productId: product._id
            })
            .sort('-scannedAt')
            .lean();

             return res.json({
                type: 'product',
                data: {
                    ...product,
                     scans: scans.map(scan => ({
                              location: scan.location,
                            scannedAt: scan.scannedAt,
                             locationName: scan.locationName
                        }))
                }
            });
        }

        return res.status(404).json({
            error: 'No scan history found for this QR code'
        });

    } catch (error) {
        console.error('Error fetching scan history:', error);
        res.status(500).json({
            error: 'Failed to fetch scan history'
        });
    }
};

module.exports = {
signQRCodeBatch,
scanQRCodeUnified,
downloadBatchZip,
getScanHistory,
scanQRCodeSeller,
};