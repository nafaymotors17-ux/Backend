const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null };

async function connectToDatabase(uri) {
  if (cached.conn) {
    console.log("⚡ Using cached MongoDB connection");
    return cached.conn;
  }

  console.log("🕓 Connecting to MongoDB:", uri);
  try {
    cached.conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
    });
    console.log("✅ MongoDB connected successfully");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
  }

  return cached.conn;
}

module.exports = connectToDatabase;
