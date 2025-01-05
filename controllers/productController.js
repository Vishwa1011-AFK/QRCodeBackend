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

const SECRET_KEY = process.env.AES_SECRET_KEY;

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

        // Generate QR code images for each product
        for (const product of products) {
            const filePath = path.join(tempDir, `${product.uuid}.png`);
            await QRCode.toFile(filePath, product.signedQRCode);
            imagePaths.push(filePath);
        }

        // Generate master QR code
        const masterQRCode = await MasterQRCode.findOne({ batchId });
        if (masterQRCode) {
            const masterFilePath = path.join(tempDir, `master-${batchId}.png`);
            await QRCode.toFile(masterFilePath, masterQRCode.masterQRCode);
            imagePaths.push(masterFilePath);
        }

        // Create ZIP file
        const zipFilePath = path.join(tempDir, `batch-${batchId}.zip`);
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.pipe(output);

        // Add all images to the ZIP
        imagePaths.forEach((filePath) => {
            archive.file(filePath, { name: path.basename(filePath) });
        });

        await archive.finalize();

        // Send the ZIP file
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=batch-${batchId}.zip`);
        const fileStream = fs.createReadStream(zipFilePath);
        fileStream.pipe(res);

        // Clean up files after sending
        fileStream.on('close', () => {
            imagePaths.forEach((filePath) => fs.unlinkSync(filePath));
            fs.unlinkSync(zipFilePath);
        });

    } catch (error) {
        console.error('Error generating batch ZIP:', error);
        res.status(500).json({ error: 'Error generating batch ZIP file' });
    }
};

// Update the signQRCodeBatch function to not handle ZIP generation
const signQRCodeBatch = async (req, res) => {
    const { name, stationId, numberOfCodes } = req.body;
    const batchId = uuidv4();
    const signedQRCodes = [];

    try {
        for (let i = 0; i < numberOfCodes; i++) {
            const uuid = uuidv4();
            const qrData = { name, stationId, uuid };
            const signedQRCode = jwt.sign(qrData, SECRET_KEY, { expiresIn: '1y' });

            const newProduct = new Product({
                name,
                stationId,
                uuid,
                signedQRCode,
                batchId,
                createdAt: new Date(),
            });

            signedQRCodes.push(signedQRCode);
            await newProduct.save();
        }

        const masterQRData = { batchId };
        const masterQRCode = jwt.sign(masterQRData, SECRET_KEY, { expiresIn: '1y' });

        const newMasterQRCode = new MasterQRCode({
            batchId,
            masterQRCode,
        });

        await newMasterQRCode.save();

        res.json({
            message: `${numberOfCodes} QR codes signed and stored successfully`,
            signedQRCodes,
            masterQRCode,
            batchId
        });
    } catch (error) {
        console.error('Error saving QR codes:', error);
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
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);
       
        if (decodedData.batchId && !decodedData.uuid) {
            // This is a master QR code
            const { batchId } = decodedData;

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

        if (decodedData.uuid) {
            // This is an individual product QR code
            const product = await Product.findOne({ uuid: decodedData.uuid });
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
        const decodedData = jwt.verify(signedQRCode, SECRET_KEY);

        if (decodedData.batchId && !decodedData.uuid) {
            // This is a master QR code
            const { batchId } = decodedData;

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

        if (decodedData.uuid) {
            // This is an individual product QR code
            const product = await Product.findOne({ uuid: decodedData.uuid });
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
        // First try to find if it's a master QR code
        const masterQR = await MasterQRCode.findOne({
            masterQRCode: signedQRCode
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
                            locationName: scan.locationName,
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
            signedQRCode
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