require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const productRoutes = require('./routes/productRoutes');

const app = express();

// CORS Options
const corsOptions = {
    origin: 'https://qr-code-frontend-rouge.vercel.app',  // Adjust this if needed
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};

// CORS Middleware
app.use(cors(corsOptions));

// Middleware
app.use(express.json()); // Built-in middleware to parse JSON

// Routes
app.use('/api/products', productRoutes);

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('MongoDB URI is not defined in .env');
    process.exit(1);  // Exit if MONGO_URI is not set
}

mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => {
        console.error('MongoDB connection error:', err);
        process.exit(1);  // Exit if there's an error connecting to DB
    });

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
