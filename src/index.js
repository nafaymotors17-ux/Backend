const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const ApiError = require("./utils/api.error");
const cookieParser = require("cookie-parser");
const connectToDatabase = require("./db"); // for vercel
const app = express();
// for vercel to have cached db this middleware helps
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error("DB Connection Middleware Error:", error);
    res.status(500).json({ error: "Database connection failed" });
  }
});
// Import routes
const authRoutes = require("./routes/auth.routes");
const adminShipmentRoutes = require("./routes/admin/shipment.routes");
const adminRoutes = require("./routes/admin/admin.route");
const clientRoutes = require("./routes/client.routes");

const photoRoutes = require("./routes/photo.routes");
// Middleware
app.use(helmet());
app.use(cookieParser());
const allowedOrigins = [
  "http://localhost:5173",
  "https://yokohama-inventory-frontend-fbve.vercel.app",
  "https://global-logistics-shipment-inventory.vercel.app",
  "*",
];
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like Postman, server-to-server)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true, // allow cookies to be sent
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// app.use(morgan("dev"));
const mongoose = require("mongoose");
app.get("/api/debug/db", async (req, res) => {
  try {
    const state = mongoose.connection.readyState;
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    res.json({
      connected: state === 1,
      state: states[state],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/shipments", adminShipmentRoutes);
app.use("/api/photos", photoRoutes);
app.use("/api/client", clientRoutes);

// Health check route
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Root route
app.use("/", (req, res) => {
  res.send("<h1>This is Yokohama Inventory Management Server Running</h1>");
});

// Global error handling middleware
app.use((error, req, res, next) => {
  let apiError = error;

  // Handle mongoose validation errors
  console.log(error);

  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map((err) => err.message);
    apiError = ApiError.validationError("Validation failed", errors[0]);
  }

  // Handle mongoose cast errors (invalid ObjectId)
  if (error.name === "CastError") {
    apiError = ApiError.badRequest("Invalid resource ID format");
  }

  // Handle mongoose duplicate key errors
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern)[0];
    apiError = ApiError.conflict(`${field} already exists`);
  }

  // Log unexpected errors
  if (!apiError.isOperational) {
    console.error("🚨 Unexpected Error:", error);
    apiError = ApiError.internalError();
  }

  // Send error response
  res.status(apiError.statusCode).json({
    success: apiError.success,
    message: apiError.message,
    type: apiError.type,
    details: apiError.details,
  });
});

module.exports = app;
