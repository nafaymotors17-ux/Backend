// const mongoose = require("mongoose");
// mongoose.set("bufferCommands", false);
// let cached = global.mongoose;
// if (!cached) cached = global.mongoose = { conn: null };

// async function connectToDatabase(uri) {
//   if (cached.conn) {
//     console.log("⚡ Using cached MongoDB connection");
//     return cached.conn;
//   }

//   console.log("🕓 Connecting to MongoDB:", uri);
//   try {
//     cached.conn = await mongoose.connect(uri, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//       serverSelectionTimeoutMS: 10000,
//     });
//     console.log("✅ MongoDB connected successfully");
//   } catch (err) {
//     console.error("❌ MongoDB connection error:", err.message);
//   }

//   return cached.conn;
// }

// module.exports = connectToDatabase;

//  For Vercel connections
const mongoose = require("mongoose");

// Disable buffering so we don't hang if the connection is slow
mongoose.set("bufferCommands", false);

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectToDatabase() {
  const uri = process.env.ATLAS_URL;

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10, // Optimized for serverless
    };

    cached.promise = mongoose.connect(uri, opts).then((mongoose) => {
      console.log("✅ New MongoDB connection established");
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

module.exports = connectToDatabase;
