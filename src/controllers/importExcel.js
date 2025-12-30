// controllers/importExcelController.js
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const moment = require("moment");
const Shipment = require("../models/shipment.model");
const User = require("../models/user.model");

// -------- Date Parser --------
function parseExcelDate(raw) {
  if (!raw) return null;

  console.log(`Raw date value: "${raw}", type: ${typeof raw}`);

  // Case 1: Excel serial number (numeric)
  if (typeof raw === "number") {
    // Excel date system - Excel incorrectly treats 1900 as a leap year
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    let days = raw;

    // Excel 1900 leap year bug correction
    if (days > 60) days--;

    const date = new Date(excelEpoch.getTime() + days * 86400000);
    // ADD 1 DAY to fix the offset for Excel serial numbers only
    const adjustedDate = new Date(date.getTime() + 86400000);
    return new Date(
      Date.UTC(
        adjustedDate.getUTCFullYear(),
        adjustedDate.getUTCMonth(),
        adjustedDate.getUTCDate()
      )
    );
  }

  // Case 2: Already a Date object (from xlsx with cellDates: true)
  if (raw instanceof Date && !isNaN(raw)) {
    // DO NOT add 1 day - it's already correct
    return new Date(
      Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate())
    );
  }

  // Case 3: String that might contain timestamp
  const s = String(raw).trim();
  if (!s || s === "　" || s === "") return null;

  console.log(`String date to parse: "${s}"`);

  // Try parsing as ISO format with timestamp first
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]);
    const month = parseInt(isoMatch[2]) - 1; // JS months are 0-indexed
    const day = parseInt(isoMatch[3]);

    const date = new Date(Date.UTC(year, month, day));
    if (!isNaN(date)) {
      return date;
    }
  }

  // Try other date formats (without adding 1 day)
  const formats = [
    "YYYY/M/D",
    "YYYY-M-D",
    "M/D/YYYY",
    "M-D-YYYY",
    "D/M/YYYY",
    "D-M-YYYY",
    "YYYY/MM/DD",
    "YYYY-MM-DD",
    "MM/DD/YYYY",
    "MM-DD-YYYY",
    "DD/MM/YYYY",
    "DD-MM-YYYY",
  ];

  const m = moment(s, formats, true);
  if (m.isValid()) {
    // DO NOT add 1 day for string dates
    return new Date(Date.UTC(m.year(), m.month(), m.date()));
  }

  // Last resort: try Date constructor
  const d = new Date(s);
  if (!isNaN(d)) {
    // DO NOT add 1 day
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
  }

  console.warn(`Failed to parse date: "${s}"`);
  return null;
}
// -------- Storage Days --------
function storageDays(gateIn, gateOut) {
  if (!gateIn || !gateOut) return 0;

  // Convert both to UTC midnight for accurate calculation
  const inUTC = Date.UTC(
    gateIn.getUTCFullYear(),
    gateIn.getUTCMonth(),
    gateIn.getUTCDate()
  );
  const outUTC = Date.UTC(
    gateOut.getUTCFullYear(),
    gateOut.getUTCMonth(),
    gateOut.getUTCDate()
  );

  const diffTime = outUTC - inUTC;
  return Math.max(0, Math.round(diffTime / 86400000));
}

// -------- MAIN IMPORT API --------
exports.importExcel = async (req, res) => {
  try {
    const filePath = path.resolve(__dirname, "..", "temp/excel.xlsx");
    if (!fs.existsSync(filePath))
      return res
        .status(400)
        .json({ success: false, message: "excel.xlsx not found" });

    // Try different XLSX reading options
    const workbook = XLSX.readFile(filePath, {
      cellDates: true,
      dateNF: "yyyy-mm-dd",
      cellStyles: false,
      sheetStubs: false,
    });

    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Try with raw: true first to get raw values
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: null,
      raw: true,
      rawNumbers: true,
    });

    console.log(`Total rows: ${rows.length}`);
    console.log("First row sample:", JSON.stringify(rows[0], null, 2));

    // Map customers
    const allCustomers = await User.find({ role: "customer" }).lean();
    const customerMap = new Map(
      allCustomers.map((u) => [u.name.trim().toUpperCase(), u._id])
    );

    const errors = [];
    const ready = [];

    let rowNumber = 1;
    for (const row of rows) {
      rowNumber++;

      const cleanRow = {};
      Object.keys(row).forEach((k) => {
        if (k) cleanRow[k.trim().toUpperCase()] = row[k];
      });

      // Parse fields - add more possible column names
      const gateInRaw =
        cleanRow["GATE IN"] ||
        cleanRow["GATE_IN"] ||
        cleanRow["GATEIN"] ||
        cleanRow["GATE IN DATE"];
      const gateOutRaw =
        cleanRow["GATE OUT"] ||
        cleanRow["GATE_OUT"] ||
        cleanRow["GATEOUT"] ||
        cleanRow["GATE OUT DATE"];
      const customer =
        cleanRow["CUSTOMER"] ||
        cleanRow["CUSTOMERS"] ||
        cleanRow["CLIENT"] ||
        cleanRow["CUSTOMER NAME"];
      const chassis =
        cleanRow["CHASSIS NO"] ||
        cleanRow["CHASSIS_NUMBER"] ||
        cleanRow["CHASSIS"] ||
        cleanRow["CHASSISNO"];

      console.log(
        `Row ${rowNumber}: gateInRaw = "${gateInRaw}", type = ${typeof gateInRaw}`
      );
      console.log(
        `Row ${rowNumber}: gateOutRaw = "${gateOutRaw}", type = ${typeof gateOutRaw}`
      );

      if (!gateInRaw || !customer || !chassis) {
        errors.push({
          row: rowNumber,
          reason: "Missing required fields",
          details: { gateInRaw, customer, chassis },
        });
        continue;
      }

      const gateInDate = parseExcelDate(gateInRaw);
      const gateOutDate = gateOutRaw ? parseExcelDate(gateOutRaw) : null;

      console.log(
        `Row ${rowNumber}: gateInDate = ${
          gateInDate ? gateInDate.toISOString() : "null"
        }`
      );
      console.log(
        `Row ${rowNumber}: gateOutDate = ${
          gateOutDate ? gateOutDate.toISOString() : "null"
        }`
      );

      if (!gateInDate) {
        errors.push({
          row: rowNumber,
          reason: "Invalid gate in date",
          value: gateInRaw,
          type: typeof gateInRaw,
        });
        continue;
      }

      const customerName = String(customer).trim().toUpperCase();
      const customerId = customerMap.get(customerName);
      if (!customerId) {
        errors.push({
          row: rowNumber,
          reason: "Unknown customer",
          value: customerName,
          available: Array.from(customerMap.keys()),
        });
        continue;
      }

      const chassisUpper = String(chassis).trim().toUpperCase();

      ready.push({
        clientId: customerId,
        carId: {
          makeModel: cleanRow["MAKER/MODEL"]
            ? String(cleanRow["MAKER/MODEL"]).trim().toUpperCase()
            : "",
          chassisNumber: chassisUpper,
          images: [],
        },
        chassisNumber: chassisUpper,
        chassisNumberReversed: chassisUpper.split("").reverse().join(""),
        gateInDate,
        gateOutDate: gateOutDate || undefined,
        vesselName: cleanRow["VESSEL"]
          ? String(cleanRow["VESSEL"]).trim().toUpperCase()
          : undefined,
        yard: cleanRow["YARD"] ? String(cleanRow["YARD"]).trim() : undefined,
        pod: cleanRow["POD"]
          ? String(cleanRow["POD"]).trim().toUpperCase()
          : undefined,
        jobNumber:
          cleanRow["JOB NO"] || cleanRow["JOB_NO"] || cleanRow["JOBNO"]
            ? String(
                cleanRow["JOB NO"] || cleanRow["JOB_NO"] || cleanRow["JOBNO"]
              )
                .trim()
                .toUpperCase()
            : undefined,
        exportStatus: gateOutDate ? "shipped" : "pending",
        storageDays: gateOutDate ? storageDays(gateInDate, gateOutDate) : 0,
        importedAt: new Date(),
      });
    }

    // Insert into DB
    const chassisList = ready.map((x) => x.chassisNumber);
    const existing = await Shipment.find(
      { chassisNumber: { $in: chassisList } },
      { chassisNumber: 1 }
    ).lean();
    const existingSet = new Set(existing.map((x) => x.chassisNumber));
    const finalDocs = ready.filter((x) => !existingSet.has(x.chassisNumber));

    let inserted = [];
    if (finalDocs.length > 0) {
      inserted = await Shipment.insertMany(finalDocs);
    }

    // Summary log
    console.log("Import Summary:");
    console.log(`- Total rows: ${rows.length}`);
    console.log(`- Valid rows: ${ready.length}`);
    console.log(`- Inserted: ${inserted.length}`);
    console.log(`- Errors: ${errors.length}`);
    console.log(`- Skipped (duplicate): ${ready.length - finalDocs.length}`);

    if (errors.length > 0) {
      console.log("First few errors:", errors.slice(0, 5));
    }

    res.json({
      success: true,
      message: "Import completed successfully",
      totalRows: rows.length,
      validRows: ready.length,
      inserted: inserted.length,
      skipped: errors.length + (ready.length - finalDocs.length),
      errors: errors.slice(0, 10),
      sampleDates: ready.slice(0, 3).map((r) => ({
        gateIn: r.gateInDate.toISOString().split("T")[0],
        gateOut: r.gateOutDate
          ? r.gateOutDate.toISOString().split("T")[0]
          : null,
      })),
    });
  } catch (err) {
    console.error("Import error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// controllers/shipmentController.js

const { calculateStoragePeriod } = require("../utils/storage.days.calc");

exports.fixShipmentDates = async (req, res) => {
  try {
    const shipments = await Shipment.find();

    const bulkOps = shipments.map((shipment) => {
      const updateFields = {};

      // ---- ADD +1 DAY TO GATE IN ----
      let newGateIn = null;
      if (shipment.gateInDate) {
        newGateIn = new Date(
          shipment.gateInDate.getTime() + 24 * 60 * 60 * 1000
        );
        updateFields.gateInDate = newGateIn;
      }

      // ---- ADD +1 DAY TO GATE OUT ----
      let newGateOut = null;
      if (shipment.gateOutDate) {
        newGateOut = new Date(
          shipment.gateOutDate.getTime() + 24 * 60 * 60 * 1000
        );
        updateFields.gateOutDate = newGateOut;
      }

      // ---- CALCULATE STORAGE DAYS USING YOUR FUNCTION ----
      if (newGateIn) {
        const storage = newGateOut
          ? calculateStoragePeriod(newGateIn, newGateOut)
          : 0;

        updateFields.storageDays = storage;
      }

      return {
        updateOne: {
          filter: { _id: shipment._id },
          update: { $set: updateFields },
        },
      };
    });

    if (bulkOps.length > 0) {
      await Shipment.bulkWrite(bulkOps);
    }

    res.json({
      success: true,
      message:
        "Dates updated (+1 day) and storageDays recalculated successfully using your formula.",
      updatedCount: bulkOps.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
