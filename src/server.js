require("dotenv").config();
const app = require("./index");
const mongoose = require("mongoose");
const URL = process.env.ATLAS_URL;
const PORT = process.env.PORT;
const serverInstance = require("http").createServer(app);
mongoose
  .connect(URL, {
    maxPoolSize: 20, // Default is 5; increase if you expect many parallel queries
    minPoolSize: 5, // Keep warm connections for lower latency
    serverSelectionTimeoutMS: 5000, // Fail fast if MongoDB is not reachable
    socketTimeoutMS: 45000, // Close inactive sockets sooner
    connectTimeoutMS: 10000, // Time to establish connection
    family: 4, // Use IPv4 for faster DNS resolution
  })
  .then(async () => {
    const connection = mongoose.connection;
    console.log(await connection.db.stats());

    serverInstance.listen(PORT);
    console.log("Database connected");
    console.log("App is listening at port", process.env.PORT);
  });
