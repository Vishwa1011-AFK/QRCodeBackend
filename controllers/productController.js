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
            await QRCode.toFile(filePath, product.signedQRCode);
            imagePaths.push(filePath);
        }

        const masterQRCode = await MasterQRCode.findOne({ batchId });
        let masterFilePath;
        if (masterQRCode) {
            masterFilePath = path.join(tempDir, `master-${batchId}.png`);
            await QRCode.toFile(masterFilePath, masterQRCode.masterQRCode);
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
    const { name, stationId, numberOfCodes, page = 1, limit = 20 } = req.body;
    
    // Add validation check
    if (!name || !stationId) {
        return res.status(400).json({ 
            error: 'Both name and stationId are required fields' 
        });
    }

    const batchId = uuidv4();
    let signedQRCodes = [];

    try {
        // Generate signed QR codes for all codes
        for (let i = 0; i < numberOfCodes; i++) {
            const uuid = uuidv4();
            const qrData = { name, stationId, uuid, batchId };
            const encryptedQrData = encrypt(JSON.stringify(qrData), SECRET_KEY);
            const signedQRCode = jwt.sign({ data: encryptedQrData }, JWT_SECRET_KEY, { expiresIn: '1y' });
            const hmac = generateHMAC(signedQRCode, HMAC_SECRET_KEY);
            
            // Create consistent QR code structure
            const fullQRCodeData = {
                token: signedQRCode,
                hmac,
                uuid,
                batchId
            };
            
            signedQRCodes.push(fullQRCodeData);
        }

        // Create all products at once
        const newProducts = signedQRCodes.map((qrCode) => new Product({
            name,
            stationId,
            uuid: qrCode.uuid,
            signedQRCode: JSON.stringify(qrCode),
            batchId,
            createdAt: new Date(),
        }));

        await Product.insertMany(newProducts);

        // Generate master QR code
        const masterQRData = { batchId };
        const encryptedMasterQRData = encrypt(JSON.stringify(masterQRData), SECRET_KEY);
        const masterQRCode = jwt.sign({ data: encryptedMasterQRData }, JWT_SECRET_KEY, { expiresIn: '1y' });
        const hmac = generateHMAC(masterQRCode, HMAC_SECRET_KEY);
        const fullMasterQRCodeData = { 
            token: masterQRCode, 
            hmac,
            batchId
        };

        const newMasterQRCode = new MasterQRCode({
            batchId,
            masterQRCode: JSON.stringify(fullMasterQRCodeData),
        });
        await newMasterQRCode.save();

        // Paginate response
        const start = (page - 1) * limit;
        const end = start + limit;
        const paginatedQRCodes = signedQRCodes.slice(start, end);

        res.json({
            message: `${paginatedQRCodes.length} QR codes retrieved`,
            signedQRCodes: paginatedQRCodes,
            masterQRCode: JSON.stringify(fullMasterQRCodeData),
            batchId,
            total: numberOfCodes,
            page,
            pages: Math.ceil(numberOfCodes / limit),
        });
    } catch (error) {
        console.error('Error saving QR codes:', error);
        res.status(500).json({ error: 'Error signing QR codes' });
    }
};

const fetchLocationName = async (latitude, longitude) => {
    try {
        // Add delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`
        );
        if (!response.ok) throw new Error('Failed to fetch location');
        const data = await response.json();
        return data.display_name || 'Location not found';
    } catch (error) {
        console.error('Error fetching location:', error);
        return 'Location unavailable';
    }
};

const scanQRCodeUnified = async (req, res) => {
    try {
        let qrCodeData;
        const { signedQRCode, location } = req.body;
        try {
            qrCodeData = JSON.parse(signedQRCode);
        } catch (error) {
            return res.status(400).json({ error: 'Invalid QR code format - must be JSON' });
        }
        
        if (!qrCodeData.token || !qrCodeData.hmac) {
            return res.status(400).json({ error: 'Malformed QR code data' });
        }
        const { token, hmac } = qrCodeData;

        if (!verifyHMAC(token, hmac, HMAC_SECRET_KEY)) {
            return res.status(400).json({ error: 'Invalid QR code: HMAC verification failed' });
        }

        const decodedToken = jwt.verify(token, JWT_SECRET_KEY);
        const encryptedQrData = decodedToken.data;
        const decryptedQrData = decrypt(encryptedQrData, SECRET_KEY);
        let qrData;
        try {
            qrData = JSON.parse(decryptedQrData);
        } catch (error) {
            return res.status(400).json({ error: 'Invalid QR code data format' });
        }

        if (qrData.batchId && !qrData.uuid) {
            // This is a master QR code
            const { batchId } = qrData;

            const products = await Product.find({ batchId });
            if (products.length === 0) {
                return res.status(404).json({ error: 'No products found for this batch' });
            }

             const { latitude, longitude } = location;
             const locationName = await fetchLocationName(latitude, longitude);
             const scanEntries = products.map(product => ({
                productId: product._id,
                location: { latitude, longitude },
                locationName: locationName,
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
                location: { latitude, longitude },
                locationName: locationName,
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
        let qrData;
        try {
            qrData = JSON.parse(decryptedQrData);
        } catch (error) {
            return res.status(400).json({ error: 'Invalid QR code data format' });
        }

        if (qrData.batchId && !qrData.uuid) {
            // This is a master QR code
            const { batchId } = qrData;
        
            const masterQR = await MasterQRCode.findOne({ batchId });
            if (!masterQR) {
                return res.status(404).json({ error: 'Master QR code not found for this batch' });
            }
        
            // Add a new scan record to masterQRCode
            masterQR.scanRecords.push({
                scannedAt: new Date(),
                location: location,
            });
            await masterQR.save();
        
            const products = await Product.find({ batchId });
            if (products.length === 0) {
                return res.status(404).json({ error: 'No products found for this batch' });
            }
        
            const { latitude, longitude } = location;
            const locationName = await fetchLocationName(latitude, longitude)
            const sellerScanEntries = products.map(product => ({
                productId: product._id,
                location: { latitude, longitude },
                locationName: locationName,
                scannedAt: new Date(), // Ensure each SellerScan has the correct scannedAt time
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

        if (!qrData.uuid) {
            // Master QR code
            const masterQR = await MasterQRCode.findOne({ batchId: qrData.batchId }).lean();
            if (masterQR) {
                const products = await Product.find({ batchId: masterQR.batchId }).lean();
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
        } else {
            // Individual QR code
            const product = await Product.findOne({ uuid: qrData.uuid }).lean();
            if (product) {
                const scans = await SellerScan.find({ productId: product._id })
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
        }
        return res.status(404).json({ error: 'No scan history found for this QR code' });
    } catch (error) {
        console.error('Error fetching scan history:', error);
        return res.status(500).json({ error: 'Failed to fetch scan history' });
    }
};

const getBatchQRCodes = async (req, res) => {
    const { batchId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    try {
        const products = await Product.find({ batchId })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));
        const total = await Product.countDocuments({ batchId });

        const signedQRCodes = products.map(product => JSON.parse(product.signedQRCode));

        res.json({
            signedQRCodes,
            page: parseInt(page),
            pages: Math.ceil(total / limit),
            total,
        });
    } catch (error) {
        console.error('Error fetching batch QR codes:', error);
        res.status(500).json({ error: 'Error fetching batch QR codes' });
    }
};

function verifyQRStructure(qrData) {
    if (!qrData.token || !qrData.hmac) {
        throw new Error('Invalid QR code structure');
    }
    if (!verifyHMAC(qrData.token, qrData.hmac, HMAC_SECRET_KEY)) {
        throw new Error('HMAC verification failed');
    }
}

module.exports = {
signQRCodeBatch,
scanQRCodeUnified,
getBatchQRCodes,
downloadBatchZip,
getScanHistory,
scanQRCodeSeller,
verifyQRStructure
};