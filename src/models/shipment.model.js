// models/Shipment.js
const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");
const aggregatePaginate = require("mongoose-aggregate-paginate-v2");
const { Schema } = mongoose;

const shipmentSchema = new Schema(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    carId: {
      makeModel: { type: String, trim: true, uppercase: true },
      chassisNumber: {
        type: String,
        required: true,
        trim: true,
      },
      images: [
        {
          key: { type: String, required: true }, // e.g. "car_photos/ABC123/1.jpg"
          url: { type: String, required: true }, // full S3 URL
          name: { type: String }, // optional (e.g. "1.jpg")
          alt: { type: String, default: "Car photo" },
        },
      ],
    },
    gateInDate: { type: Date, required: true, index: true },
    gateOutDate: { type: Date, index: true },
    // Vessel reference - use vessel entity
    vesselId: {
      type: Schema.Types.ObjectId,
      ref: "Vessel",
      index: true,
    },
    yard: { type: String, trim: true, index: true },
    // glNumber: {
    //   type: String,
    //   trim: true,
    //   uppercase: true,

    // },

    storageDays: { type: Number, default: 0 },
    exportStatus: {
      type: String,
      enum: ["cancelled", "unshipped", "shipped", "pending"],
      default: "pending",
      index: true,
    },
    // OPTIONAL: denormalized chassisNumber for faster searches (recommended)
    chassisNumber: { type: String, uppercase: true, trim: true },
    chassisNumberReversed: { type: String, uppercase: true, trim: true },
    remarks: { type: String, trim: true },
  },
  { timestamps: true }
);
shipmentSchema.pre("save", function (next) {
  if (this.chassisNumber) {
    this.chassisNumberReversed = this.chassisNumber
      .split("")
      .reverse()
      .join("");
  }
  next();
});
// Compound indexes tuned for common queries
shipmentSchema.index({ _id: 1, clientId: 1 });
// Note: clientName field doesn't exist in schema, removed invalid index
// keep createdAt index for sorting / recent queries
shipmentSchema.index({ createdAt: -1 });
// In Shipment schema
shipmentSchema.index({ chassisNumber: 1 });
shipmentSchema.index({ chassisNumberReversed: 1 });

// shipmentSchema.index(
//   { jobNumber: 1 },
//   {
//     unique: true,
//     partialFilterExpression: { jobNumber: { $exists: true, $ne: null } },
//   }
// );
shipmentSchema.plugin(mongoosePaginate);
shipmentSchema.plugin(aggregatePaginate);
module.exports = mongoose.model("Shipment", shipmentSchema);
