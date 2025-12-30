// // models/Car.js
// const mongoose = require("mongoose");
// const { Schema } = mongoose;

// const carSchema = new Schema(
//   {
//     makeModel: { type: String, trim: true, uppercase: true },
//     chassisNumber: {
//       type: String,
//       required: true,
//       unique: true,
//       trim: true,
//       index: true, // <--- index chassisNumber
//     },
//     images: [
//       {
//         key: { type: String, required: true }, // e.g. "car_photos/ABC123/1.jpg"
//         url: { type: String, required: true }, // full S3 URL
//         name: { type: String }, // optional (e.g. "1.jpg")
//         alt: { type: String, default: "Car photo" },
//       },
//     ],
//   },
//   { timestamps: true }
// );

// // optional text index on makeModel if you do fuzzy search there
// carSchema.index({ makeModel: "text" });

// module.exports = mongoose.model("Car", carSchema);
