// models/Vessel.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const vesselSchema = new Schema(
  {
    vesselName: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    jobNumber: {
      type: String,
      trim: true,
      uppercase: true,
    },
    etd: {
      type: Date,
    },
    shippingLine: {
      type: String,
      trim: true,
      uppercase: true,
    },
    pod: {
      type: String,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true }
);

// Compound index for vesselName and jobNumber
vesselSchema.index({ vesselName: 1, jobNumber: 1 });

module.exports = mongoose.model("Vessel", vesselSchema);
