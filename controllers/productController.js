require('dotenv').config();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const archiver = require('archiver');
const Product = require('../models/product');
const Scan = require('../models/scan');
const MasterQRCode = require('../models/masterQRCode');
const SellerScan = require('../models/sellerScan');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');

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

const signQRCodeBatch = async (req, res) => {
    const { name, stationId, numberOfCodes, page = 1, limit = 20 } = req.body;
  
    if (!name || !stationId) {
      return res.status(400).json({ error: 'Both name and stationId are required fields' });
    }
  
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(name)) {
      return res.status(400).json({ error: 'Name must be alphanumeric (with hyphens) and up to 50 characters' });
    }
  
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(stationId)) {
      return res.status(400).json({ error: 'Station ID must be alphanumeric (with hyphens) and up to 50 characters' });
    }
  
    if (!Number.isInteger(numberOfCodes) || numberOfCodes <= 0 || numberOfCodes > 10000) {
      return res.status(400).json({ error: 'Number of codes must be an integer between 1 and 10,000' });
    }
  
    const batchId = uuidv4();
    const chunkSize = 100;
  
    try {
      const totalChunks = Math.ceil(numberOfCodes / chunkSize);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, numberOfCodes);
        const chunkQRCodes = [];
  
        for (let j = start; j < end; j++) {
          const uuid = uuidv4();
          const qrData = { name, stationId, uuid, batchId };
          const encryptedQrData = encrypt(JSON.stringify(qrData), SECRET_KEY);
          const signedQRCode = jwt.sign({ data: encryptedQrData }, JWT_SECRET_KEY, { expiresIn: '1y' });
          const hmac = generateHMAC(signedQRCode, HMAC_SECRET_KEY);
  
          const fullQRCodeData = {
            token: signedQRCode,
            hmac,
            uuid,
            batchId,
          };
  
          chunkQRCodes.push({
            insertOne: {
              document: {
                name,
                stationId,
                uuid,
                signedQRCode: JSON.stringify(fullQRCodeData),
                batchId,
                createdAt: new Date(),
              },
            },
          });
        }
  
        await Product.bulkWrite(chunkQRCodes);
      }
  
      // Master QR code generation remains the same
      const masterQRData = { batchId };
      const encryptedMasterQRData = encrypt(JSON.stringify(masterQRData), SECRET_KEY);
      const masterQRCode = jwt.sign({ data: encryptedMasterQRData }, JWT_SECRET_KEY, { expiresIn: '1y' });
      const hmac = generateHMAC(masterQRCode, HMAC_SECRET_KEY);
      const fullMasterQRCodeData = {
        token: masterQRCode,
        hmac,
        batchId,
      };
  
      const newMasterQRCode = new MasterQRCode({
        batchId,
        masterQRCode: JSON.stringify(fullMasterQRCodeData),
      });
      await newMasterQRCode.save();
  
      const products = await Product.find({ batchId })
        .skip((page - 1) * limit)
        .limit(parseInt(limit));
      const total = await Product.countDocuments({ batchId });
  
      const signedQRCodes = products.map((product) => JSON.parse(product.signedQRCode));
  
      res.json({
        message: `${signedQRCodes.length} QR codes retrieved`,
        signedQRCodes,
        masterQRCode: JSON.stringify(fullMasterQRCodeData),
        batchId,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('Error saving QR codes:', error);
      res.status(500).json({ error: 'Error signing QR codes' });
    }
  };

const downloadBatchZip = async (req, res) => {
  const { batchId } = req.params;
  try {
    const products = await Product.find({ batchId });
    if (products.length === 0) {
      return res.status(404).json({ error: 'No products found for this batch' });
    }

    const masterQRCode = await MasterQRCode.findOne({ batchId });
    if (!masterQRCode) {
      return res.status(404).json({ error: 'Master QR code not found for this batch' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=batch-${batchId}.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Add master QR code
    const masterQRBuffer = await QRCode.toBuffer(masterQRCode.masterQRCode);
    archive.append(masterQRBuffer, { name: `master-${batchId}.png` });

    // Add product QR codes
    for (const product of products) {
      const qrBuffer = await QRCode.toBuffer(product.signedQRCode);
      archive.append(qrBuffer, { name: `${product.uuid}.png` });
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error generating batch ZIP:', error);
    res.status(500).json({ error: 'Error generating batch ZIP file' });
  }
};

const cache = new LRUCache({
    max: 5000, // Increased cache size
    maxAge: 1000 * 60 * 60, // 1 hour TTL for successful responses
  });

const locationFetchQueue = new Map();

const fetchLocationName = async (latitude, longitude) => {
  const key = `${latitude},${longitude}`;

  // Return cached result if available
  if (cache.has(key)) {
    return cache.get(key);
  }

  // Check for existing request
  if (locationFetchQueue.has(key)) {
    return await locationFetchQueue.get(key);
  }

  try {
    const fetchPromise = (async () => {
      try {
        // Respect Nominatim's rate limit policy
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`
        );
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        const locationName = data.display_name || 'Location not found';
        
        // Cache successful response
        cache.set(key, locationName);
        return locationName;
      } catch (error) {
        console.error('Error fetching location:', error);
        const errorMessage = 'Location unavailable';
        
        // Cache errors for shorter duration (5 minutes)
        cache.set(key, errorMessage, { maxAge: 1000 * 60 * 5 });
        return errorMessage;
      } finally {
        locationFetchQueue.delete(key);
      }
    })();

    // Store promise in queue
    locationFetchQueue.set(key, fetchPromise);
    return await fetchPromise;
  } catch (error) {
    console.error('Unexpected error in location fetch:', error);
    return 'Location service unavailable';
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