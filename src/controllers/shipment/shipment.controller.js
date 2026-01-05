const Shipment = require("../../models/shipment.model.js");
const ApiError = require("../../utils/api.error");
const ApiResponse = require("../../utils/api.response");
const asyncHandler = require("../../utils/asyncHandler");
const mongoose = require("mongoose");
const { get, set, del, keys, clearShipmentCache } = require("../cache"); // ✅ must have keys() in cache.js
const crypto = require("crypto");

// const triggerDeletePhotos = require("../../aws/lambda/deleteCarPhotos");
const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // safe regex escape
const { calculateStoragePeriod } = require("../../utils/storage.days.calc.js");
const { deletePhotosFromS3 } = require("../../utils/s3DeleteHelper.js");
// Helper: stable hash for filters
const filterHash = (filters) =>
  crypto.createHash("md5").update(JSON.stringify(filters)).digest("hex");

exports.listShipments = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    yard,
    vesselName,
    exportStatus,
    dateType,
    dateFrom,
    dateTo,
    chassisNumber,
    jobNumber,
    inYard,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query;

  let clientId = null;
  if (req.query?.clientId) {
    clientId = new mongoose.Types.ObjectId(req.query.clientId);
  }

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));

  // -------------------- FILTER BUILD --------------------
  const filter = {};

  if (clientId) filter.clientId = clientId;
  if (yard) filter.yard = { $regex: escapeRegex(yard), $options: "i" };
  if (vesselName)
    filter.vesselName = { $regex: escapeRegex(vesselName), $options: "i" };
  if (exportStatus) filter.exportStatus = exportStatus;
  if (jobNumber)
    filter.jobNumber = { $regex: escapeRegex(jobNumber), $options: "i" };
  if (inYard) filter.storageDays = 0;

  // -------------------- DATE RANGE FILTER --------------------
  if (dateFrom || dateTo) {
    const fromDate = dateFrom ? new Date(dateFrom) : null;
    const toDate = dateTo ? new Date(dateTo) : null;

    if (fromDate) fromDate.setHours(0, 0, 0, 0);
    if (toDate) toDate.setHours(23, 59, 59, 999);

    if (dateType === "gateOut") {
      if (fromDate && toDate) {
        filter.gateOutDate = { $gte: fromDate, $lte: toDate };
      } else if (fromDate) {
        filter.gateOutDate = { $gte: fromDate };
      } else if (toDate) {
        filter.gateOutDate = { $lte: toDate };
      }
    } else if (dateType === "gateIn") {
      if (fromDate && toDate) {
        filter.gateInDate = { $gte: fromDate, $lte: toDate };
      } else if (fromDate) {
        filter.gateInDate = { $gte: fromDate };
      } else if (toDate) {
        filter.gateInDate = { $lte: toDate };
      }
    }
  }

  // -------------------- CHASSIS SEARCH --------------------
  if (chassisNumber && chassisNumber.trim()) {
    const term = escapeRegex(chassisNumber.trim().toUpperCase());
    const reversedTerm = term.split("").reverse().join("");

    filter.$or = [
      { chassisNumber: term },
      { chassisNumber: { $regex: `^${term}`, $options: "i" } },
      { chassisNumberReversed: { $regex: `^${reversedTerm}`, $options: "i" } },
    ];
  }

  // -------------------- SORTING --------------------
  const allowedSortFields = [
    "gateInDate",
    "createdAt",
    "vesselName",
    "yard",
    "jobNumber",
    "pod",
    "exportStatus",
    "storageDays",
  ];

  const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
  const normalizedSortOrder = ["asc", "desc"].includes(sortOrder)
    ? sortOrder
    : "desc";

  const sortOptions = {};
  sortOptions[safeSortBy] = normalizedSortOrder === "asc" ? 1 : -1;
  sortOptions.createdAt = normalizedSortOrder === "asc" ? 1 : -1;

  // -------------------- CACHE KEY --------------------
  const filterSignature = Object.keys(filter).length
    ? filterHash(filter)
    : "nofilter";
  const sortSignature = `${safeSortBy}_${normalizedSortOrder}`;
  const cacheKeyPrefix = `shipments_${filterSignature}_${sortSignature}`;
  const cacheKey = `${cacheKeyPrefix}_${pageNum}`;

  // -------------------- FETCH FUNCTION --------------------
  const fetchAndCache = async (pageToFetch) => {
    const key = `${cacheKeyPrefix}_${pageToFetch}`;
    const cached = get(key);
    if (cached) return cached;

    const skip = (pageToFetch - 1) * limitNum;

    // -------------------- OPTIMIZED AGGREGATION PIPELINE --------------------
    const pipeline = [];

    // 1. Match with filters
    pipeline.push({ $match: filter });
    pipeline.push({
      $match: {
        [safeSortBy]: { $exists: true, $ne: null },
      },
    });
    // 2. Sort
    pipeline.push({ $sort: sortOptions });

    // 3. Facet to get both count and paginated data in one query
    pipeline.push({
      $facet: {
        metadata: [{ $count: "totalItems" }],
        data: [
          { $skip: skip },
          { $limit: limitNum },

          // FIXED: Add imageCount INSIDE carId object
          {
            $addFields: {
              "carId.imageCount": {
                $cond: {
                  if: { $isArray: "$carId.images" },
                  then: { $size: "$carId.images" },
                  else: 0,
                },
              },
            },
          },

          // Remove the images array to reduce payload
          {
            $addFields: {
              "carId.images": "$$REMOVE",
            },
          },

          // Lookup client
          {
            $lookup: {
              from: "users",
              localField: "clientId",
              foreignField: "_id",
              as: "clientId",
            },
          },
          {
            $unwind: {
              path: "$clientId",
              preserveNullAndEmptyArrays: true,
            },
          },
          // Format the response - match your original response structure
          {
            $project: {
              // Shipment fields
              gateInDate: 1,
              gateOutDate: 1,
              vesselName: 1,
              yard: 1,
              pod: 1,
              jobNumber: 1,
              storageDays: 1,
              exportStatus: 1,
              chassisNumber: 1,
              chassisNumberReversed: 1,
              remarks: 1,
              createdAt: 1,
              updatedAt: 1,

              // Car fields - includes imageCount inside carId
              carId: {
                makeModel: "$carId.makeModel",
                chassisNumber: "$carId.chassisNumber",
                imageCount: "$carId.imageCount",
              },

              // Client fields
              "clientId._id": 1,
              "clientId.name": 1,
              "clientId.userId": 1,
              "clientId.email": 1,
            },
          },
        ],
      },
    });

    // Execute aggregation
    const result = await Shipment.aggregate(pipeline).allowDiskUse(true);

    // Extract data from facet result
    const metadata = result[0]?.metadata[0] || { totalItems: 0 };
    const docs = result[0]?.data || [];
    const totalItems = metadata.totalItems;

    // Format response
    const response = ApiResponse.paginated(
      "Shipments retrieved successfully",
      docs,
      {
        currentPage: pageToFetch,
        totalPages: Math.ceil(totalItems / limitNum),
        totalItems,
        itemsPerPage: limitNum,
        hasNextPage: pageToFetch * limitNum < totalItems,
        hasPrevPage: pageToFetch > 1,
        sortBy: safeSortBy,
        sortOrder: normalizedSortOrder,
      }
    );

    // Cache the response
    set(key, response);
    return response;
  };

  // -------------------- MAIN RESPONSE --------------------
  const cached = get(cacheKey);
  let response;

  if (cached) {
    console.log(`✅ Cache hit for ${cacheKey}`);
    response = cached;
  } else {
    console.log(`⚙️ Fetching from DB for ${cacheKey}`);
    response = await fetchAndCache(pageNum);
  }

  res.status(200).json(response);

  // -------------------- PREFETCH --------------------
  [pageNum - 1, pageNum + 1].forEach((p) => {
    if (p > 0 && !get(`${cacheKeyPrefix}_${p}`)) {
      fetchAndCache(p).catch((err) => {
        console.error("Prefetch failed for page", p, err);
      });
    }
  });

  // -------------------- CACHE CLEANUP --------------------
  const allKeys = keys().filter((k) => k.startsWith(cacheKeyPrefix));
  const keepPages = [pageNum - 1, pageNum, pageNum + 1];

  allKeys.forEach((k) => {
    const match = k.match(/_(\d+)$/);
    const p = match ? parseInt(match[1]) : null;
    if (p && !keepPages.includes(p)) {
      del(k);
      console.log(`🗑️ Removed cache ${k}`);
    }
  });
});

const VALID_EXPORT_STATUSES = ["pending", "shipped", "unshipped", "cancelled"];
exports.createShipment = asyncHandler(async (req, res) => {
  try {
    const {
      customerId: clientId,
      carName,
      chassisNo,
      gateInDate,
      gateOutDate,
      vessel: vesselName,
      yard,
      pod,
      // glNumber,
      jobNumber,
      exportStatus = "pending",
      remarks,
    } = req.body;

    // Validation
    if (!clientId || !chassisNo || !gateInDate) {
      throw ApiError.badRequest(
        "clientId, chassisNo, and gateInDate are required"
      );
    }

    const chassisNumber = chassisNo.trim().toUpperCase();
    const gateIn = new Date(gateInDate);
    const gateOut = gateOutDate ? new Date(gateOutDate) : null;

    if (gateOut && gateOut < gateIn) {
      throw ApiError.badRequest(
        "Gate out date cannot be earlier than gate in date"
      );
    }

    if (!VALID_EXPORT_STATUSES.includes(exportStatus)) {
      throw ApiError.badRequest("Invalid export status");
    }

    // Check for duplicates
    const duplicateShipment = await Shipment.findOne({
      // $or: [{ chassisNumber }, ...(jobNumber ? [{ jobNumber }] : [])],
      $or: [{ chassisNumber }],
    });

    if (duplicateShipment) {
      if (duplicateShipment.chassisNumber === chassisNumber) {
        throw ApiError.badRequest(
          `Chassis number "${chassisNumber}" already exists`
        );
      }
      // if (jobNumber && duplicateShipment.jobNumber === jobNumber) {
      //   throw ApiError.badRequest(`Job number "${jobNumber}" already exists`);
      // }
    }

    // Build shipment object dynamically — only include fields that exist
    const shipmentData = {
      clientId: clientId._id,
      carId: {
        makeModel: carName ? carName.trim().toUpperCase() : undefined,
        chassisNumber,
        images: [],
      },
      chassisNumber,
      gateInDate: gateIn,
      exportStatus,
      storageDays: gateOut ? calculateStoragePeriod(gateIn, gateOut) : 0,
    };

    if (gateOut) shipmentData.gateOutDate = gateOut;
    if (vesselName) shipmentData.vesselName = vesselName;
    if (yard) shipmentData.yard = yard;
    if (pod) shipmentData.pod = pod;
    // if (job) shipmentData.glNumber = glNumber;
    if (jobNumber) shipmentData.jobNumber = jobNumber;
    if (remarks) shipmentData.remarks = remarks;
    const shipment = new Shipment(shipmentData);
    await shipment.save();

    // Optional: populate client and car for response
    const populated = {
      ...shipment.toObject(),
      clientId: {
        _id: clientId._id,
        name: clientId.name,
        userId: clientId.userId,
      },
    };
    clearShipmentCache();
    return res
      .status(201)
      .json(ApiResponse.created("Shipment created successfully", populated));
  } catch (err) {
    throw ApiError.badRequest(err.message || "Failed to create shipment");
  }
});

/**
 * Update an existing shipment (safe + rollback-proof)
 */
const sanitizeInput = (obj) => {
  const sanitized = {};
  for (const key in obj) {
    if (Object.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      // Check if the value is a string and is empty after trimming
      if (typeof value === "string" && value.trim() === "") {
        sanitized[key] = undefined; // Convert empty string to undefined (omits from DB)
      } else {
        sanitized[key] = value; // Keep other values (including valid strings, nulls, and numbers)
      }
    }
  }
  return sanitized;
};

exports.updateShipment = asyncHandler(async (req, res) => {
  // Keep a reference to the original body for `hasOwnProperty` checks
  const originalBody = req.body;

  // Apply sanitization: "" -> undefined
  const sanitizedBody = sanitizeInput(originalBody);
  console.log("Orignal body : ", originalBody);
  console.log("Sanitized body : ", sanitizedBody);

  try {
    const { id } = req.params;
    const {
      clientId,
      carName,
      chassisNumber,
      gateInDate,
      gateOutDate,
      vesselName,
      yard,
      pod,
      // glNumber,
      jobNumber,
      exportStatus,
      remarks,
    } = sanitizedBody;
    if (!chassisNumber || !gateInDate) {
      throw ApiError.badRequest("All required fields must be provided");
    }

    // 1️⃣ Find the shipment and associated car
    const shipment = await Shipment.findById(id);
    if (!shipment) throw ApiError.notFound("Shipment not found");

    // 2️⃣ Normalize input
    // chassisNumber is guaranteed to be non-falsy here.
    const newChassis = chassisNumber.toUpperCase();

    // If jobNumber is undefined (from "" or missing), use the existing value for the check.
    const newJob = jobNumber ?? shipment.jobNumber;

    // 3️⃣ Check uniqueness (Logic remains correct for checking normalized values)

    const duplicates = await Shipment.aggregate([
      {
        $match: {
          _id: { $ne: shipment._id },
          $or: [
            newChassis ? { chassisNumber: newChassis } : null,
            // newJob ? { jobNumber: newJob } : null,
          ].filter(Boolean),
        },
      },
      // { $project: { chassisNumber: 1, jobNumber: 1 } },
      { $project: { chassisNumber: 1 } },
    ]);

    if (duplicates.length > 0) {
      const dup = duplicates[0];
      if (dup.chassisNumber === newChassis)
        throw ApiError.badRequest(
          `Chassis number "${newChassis}" already exists`
        );
      // if (dup.jobNumber === newJob)
      //   throw ApiError.badRequest(`Job number "${newJob}" already exists`);
    }

    if (originalBody.hasOwnProperty("carName")) {
      // If carName is a non-empty string, update it.
      // If carName is undefined (from "" input), Mongoose will remove the field (makeModel).
      shipment.carId.makeModel = carName
        ? carName.trim().toUpperCase()
        : undefined;
    }
    // chassisNumber is mandatory and already validated/normalized
    shipment.carId.chassisNumber = newChassis;

    // Mandatory/Non-optional fields:
    if (clientId) shipment.clientId = clientId._id ? clientId._id : clientId;
    shipment.gateInDate = new Date(gateInDate); // Guaranteed to be valid
    shipment.chassisNumber = newChassis;

    // --- Gate Out Date Handling ---
    // Check originalBody to see if user provided a value (even "" or null)
    if (originalBody.hasOwnProperty("gateOutDate")) {
      // If gateOutDate is defined (i.e., not "" but a date string or null)
      if (gateOutDate !== undefined) {
        shipment.gateOutDate = gateOutDate ? new Date(gateOutDate) : null;
      } else {
        // User provided "" (sanitized to undefined) - treat as clearing to null
        shipment.gateOutDate = null;
        // Reset storage days
      }

      // Recalculate storage days based on the new date (null or date)
      shipment.storageDays = gateOutDate
        ? calculateStoragePeriod(shipment.gateInDate, shipment.gateOutDate)
        : 0;
    }

    // --- Optional String Fields (The core fix for "" -> undefined) ---

    // Pattern: if the field was sent in the request, set the shipment property to the
    // sanitized value (non-empty string or undefined). Mongoose will omit `undefined`.

    if (originalBody.hasOwnProperty("vesselName")) {
      shipment.vesselName = vesselName
        ? vesselName.trim().toUpperCase()
        : undefined;
    }
    if (originalBody.hasOwnProperty("yard")) {
      shipment.yard = yard ? yard.trim() : undefined;
    }
    // You sent 'pod' as "TOKYO", which is a valid update. This should work correctly:
    if (originalBody.hasOwnProperty("pod")) {
      shipment.pod = pod ? pod.trim().toUpperCase() : undefined;
    }
    // if (originalBody.hasOwnProperty("glNumber")) {
    //   shipment.glNumber = glNumber ? glNumber.trim() : undefined;
    // }
    if (originalBody.hasOwnProperty("jobNumber")) {
      // Use `jobNumber` from the sanitized body, which is undefined if input was "".
      shipment.jobNumber = jobNumber ? jobNumber.trim() : undefined;
    }
    if (originalBody.hasOwnProperty("exportStatus")) {
      shipment.exportStatus = exportStatus; // Status is validated separately
    }
    if (originalBody.hasOwnProperty("remarks")) {
      shipment.remarks = remarks ? remarks.trim() : "";
    }

    await shipment.save();

    clearShipmentCache();
    // ... (response logic)
    const populated = {
      ...shipment.toObject(),
      clientId: clientId?._id
        ? { _id: clientId._id, name: clientId.name, userId: clientId.userId }
        : shipment.clientId,
    };

    return res
      .status(200)
      .json(ApiResponse.success("Shipment updated successfully", populated));
  } catch (err) {
    throw ApiError.badRequest(err.message || "Failed to update shipment");
  }
});

/**
 * Update remarks for a shipment
 */
exports.updateRemarks = asyncHandler(async (req, res) => {
  const { id, remarks } = req.body;

  if (!id) {
    throw ApiError.badRequest("Shipment ID is required");
  }

  // Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest("Invalid shipment ID format");
  }

  // Find the shipment
  const shipment = await Shipment.findById(id);
  if (!shipment) {
    throw ApiError.notFound("Shipment not found");
  }

  // Update remarks
  shipment.remarks = remarks ? remarks.trim() : "";

  await shipment.save();

  clearShipmentCache();

  const response = ApiResponse.success(
    "Remarks updated successfully",
    shipment.toObject()
  );

  res.status(response.statusCode).json(response);
});

/**
 * Delete a shipment
 */
exports.deleteShipment = asyncHandler(async (req, res) => {
  const { id: shipmentId } = req.params;

  const deletedShipment = await Shipment.findOneAndDelete({ _id: shipmentId });
  if (!deletedShipment) throw new Error("Shipment not found");

  clearShipmentCache();

  // Delete photos immediately (Promise)
  if (
    deletedShipment.chassisNumber &&
    deletedShipment.carId?.images?.length > 0
  ) {
    await deletePhotosFromS3(deletedShipment._id); // Use shipment ID as chassis identifier
  }

  res.status(200).json({
    success: true,
    message: `Shipment deleted! ${
      deletedShipment.carId?.images?.length > 0 ? "Photos removed from S3." : ""
    }`,
    shipmentId: deletedShipment._id,
    carId: deletedShipment.carId?._id,
  });
});

exports.deleteShipments = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    throw ApiError.badRequest("Please provide shipment IDs.");

  // Fetch only shipments that actually exist
  const shipments = await Shipment.find({ _id: { $in: ids } });

  if (!shipments.length) throw ApiError.notFound("No shipments found");

  // Extract chassisNumbers ONLY for shipments that have photos
  const shipmentsWithPhotos = shipments.filter(
    (s) => Array.isArray(s.carId?.images) && s.carId.images.length > 0
  );

  const chassisNumbers = shipmentsWithPhotos.map((s) => s._id); // Use shipment IDs as chassis identifiers

  // Delete MongoDB records
  await Shipment.deleteMany({ _id: { $in: ids } });

  // Clear cache
  clearShipmentCache();

  // Delete S3 photos only for shipments that have photos
  if (chassisNumbers.length > 0) {
    await Promise.all(
      chassisNumbers.map((chassis) => deletePhotosFromS3(chassis))
    );
  }

  const message =
    chassisNumbers.length > 0
      ? `${shipments.length} shipment(s) deleted! Photos removed from S3.`
      : `${shipments.length} shipment(s) deleted!`;

  res.status(200).json({
    success: true,
    message,
    deletedShipmentIds: ids,
    chassisNumbers,
  });
});

/**
 * List all shipments with pagination and filtering (optimized)
 */

const ExcelJS = require("exceljs");

// exports.exportShipmentsExcel = async (req, res, next) => {
//   try {
//     const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
//       stream: res,
//       useSharedStrings: true, // IMPORTANT FIX
//       useStyles: true,
//     });

//     const sheet = workbook.addWorksheet("Shipments");

//     // === HTTP RESPONSE HEADERS ===
//     const dateStamp = new Date().toISOString().split("T")[0];
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="shipments_${dateStamp}.xlsx"`
//     );
//     res.setHeader(
//       "Content-Type",
//       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//     );

//     // =============================
//     //  FIX: Set column widths FIRST
//     // =============================
//     sheet.columns = [
//       { width: 14 }, // Yard In
//       { width: 14 }, // Yard Out
//       { width: 20 }, // Vessel
//       { width: 25 }, // Company
//       { width: 12 }, // User ID
//       { width: 22 }, // Make/Model
//       { width: 10 }, // Yard
//       { width: 18 }, // Chassis
//       { width: 12 }, // Job #
//       // { width: 14 }, // GL
//       { width: 12 }, // POD
//       { width: 14 }, // Status
//       { width: 14 }, // Storage
//       { width: 12 }, // Total Images
//     ];

//     // =============================
//     //  FIX: Freeze AFTER columns
//     // =============================
//     sheet.views = [{ state: "frozen", ySplit: 4 }];

//     // ========== TITLE ==========
//     sheet.mergeCells("A1:M1");
//     const titleCell = sheet.getCell("A1");
//     titleCell.value = "Yokohama Global Logistics Inventory Report";
//     titleCell.font = { size: 18, bold: true, color: { argb: "FFFFFFFF" } };
//     titleCell.alignment = { horizontal: "center", vertical: "middle" };
//     titleCell.fill = {
//       type: "pattern",
//       pattern: "solid",
//       fgColor: { argb: "FF2E5A87" },
//     };
//     sheet.getRow(1).commit();

//     // Subtitle
//     sheet.mergeCells("A2:M2");
//     const subtitleCell = sheet.getCell("A2");
//     subtitleCell.value = `Generated on: ${new Date().toLocaleString("en-US", {
//       timeZone: "Asia/Tokyo",
//     })}`;
//     subtitleCell.font = { italic: true, size: 12 };
//     subtitleCell.alignment = { horizontal: "center" };
//     sheet.getRow(2).commit();

//     // Empty row
//     sheet.addRow([]).commit();

//     // =============================
//     //  HEADER ROW
//     // =============================
//     const headerRow = sheet.addRow([
//       "Yard In Date",
//       "Yard Out Date",
//       "Vessel",
//       "Company",
//       "User ID",
//       "Make/Model",
//       "Yard",
//       "Chassis",
//       "Job #",
//       // "GL Number",
//       "POD",
//       "Status",
//       "Storage Days",
//       "Total Images",
//     ]);

//     headerRow.eachCell((cell) => {
//       cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
//       cell.fill = {
//         type: "pattern",
//         pattern: "solid",
//         fgColor: { argb: "FF4F81BD" },
//       };
//       cell.alignment = {
//         horizontal: "center",
//         vertical: "middle",
//         wrapText: true,
//       };
//     });

//     headerRow.commit();

//     // =============================
//     // STREAM DB FETCH
//     // =============================
//     const cursor = Shipment.aggregate([
//       { $match: {} },

//       // Lookups (WITH preserveNull)
//       {
//         $lookup: {
//           from: "users",
//           localField: "clientId",
//           foreignField: "_id",
//           as: "client",
//         },
//       },
//       { $unwind: { path: "$client", preserveNullAndEmptyArrays: true } },

//       // Project flatten
//       {
//         $project: {
//           gateInDate: 1,
//           gateOutDate: 1,
//           vesselName: 1,
//           yard: 1,
//           jobNumber: 1,
//           // glNumber: 1,
//           pod: 1,
//           exportStatus: 1,
//           storageDays: 1,

//           clientName: "$client.name",
//           clientUserId: "$client.userId",

//           carMakeModel: "$carId.makeModel",
//           carChassisNumber: "$carId.chassisNumber",
//           totalImages: { $size: "$carId.images" },
//         },
//       },
//     ]).cursor({ batchSize: 500 });

//     // =============================
//     // PROCESS & WRITE ROWS
//     // =============================
//     let total = 0;

//     for await (const s of cursor) {
//       const row = sheet.addRow([
//         s.gateInDate ? s.gateInDate.toISOString().split("T")[0] : "",
//         s.gateOutDate ? s.gateOutDate.toISOString().split("T")[0] : "",
//         s.vesselName || "",
//         s.clientName || "",
//         s.clientUserId || "",
//         s.carMakeModel || "",
//         s.carChassisNumber || "", // FIXED — no longer disappears
//         s.yard || "",
//         s.jobNumber || "",
//         // s.glNumber || "",
//         s.pod || "",
//         s.exportStatus || "",
//         s.storageDays || "",
//         s.totalImages || 0,
//       ]);

//       // FIX: MUST commit every row
//       row.commit();
//       total++;
//     }

//     //-----------------------------------------------------

//     // SUMMARY ROW
//     const summaryRow = sheet.addRow([
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       "",
//       `Total: ${total} records`,
//     ]);
//     summaryRow.font = { bold: true };
//     summaryRow.commit();

//     sheet.commit();
//     await workbook.commit();
//   } catch (err) {
//     console.error(err);
//     if (!res.headersSent)
//       return res.status(500).json({ error: "Excel export failed" });
//   }
// };

exports.exportShipmentsExcel = asyncHandler(async (req, res) => {
  const {
    clientId,
    yard,
    vesselName,
    exportStatus,
    dateType,
    dateFrom,
    dateTo,
    chassisNumber,
    jobNumber,
    inYard,
  } = req.query;

  const filter = {};

  if (clientId) filter.clientId = new mongoose.Types.ObjectId(clientId);
  if (yard) filter.yard = { $regex: escapeRegex(yard), $options: "i" };
  if (vesselName)
    filter.vesselName = { $regex: escapeRegex(vesselName), $options: "i" };
  if (exportStatus) filter.exportStatus = exportStatus;
  if (jobNumber)
    filter.jobNumber = { $regex: escapeRegex(jobNumber), $options: "i" };
  if (inYard === "true") filter.storageDays = { $eq: 0 };

  if (dateFrom || dateTo) {
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo) : null;
    if (from) from.setHours(0, 0, 0, 0);
    if (to) to.setHours(23, 59, 59, 999);

    if (dateType === "gateOut") {
      if (from && to) filter.gateOutDate = { $gte: from, $lte: to };
      else if (from) filter.gateOutDate = { $gte: from };
      else if (to) filter.gateOutDate = { $lte: to };
    } else if (dateType === "gateIn") {
      if (from && to) filter.gateInDate = { $gte: from, $lte: to };
      else if (from) filter.gateInDate = { $gte: from };
      else if (to) filter.gateInDate = { $lte: to };
    }
  }

  if (chassisNumber && chassisNumber.trim()) {
    const term = escapeRegex(chassisNumber.trim().toUpperCase());
    const revTerm = term.split("").reverse().join("");
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { chassisNumber: term },
        { chassisNumber: { $regex: `^${term}`, $options: "i" } },
        { chassisNumberReversed: { $regex: `^${revTerm}`, $options: "i" } },
      ],
    });
  }

  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useSharedStrings: true,
      useStyles: true,
    });

    const sheet = workbook.addWorksheet("Shipments");

    // === HTTP RESPONSE HEADERS ===
    const dateStamp = new Date().toISOString().split("T")[0];
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shipments_${dateStamp}.xlsx"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    // Columns & freeze
    sheet.columns = [
      { width: 14 },
      { width: 14 },
      { width: 20 },
      { width: 25 },
      { width: 12 },
      { width: 22 },
      { width: 10 },
      { width: 18 },
      { width: 12 },
      { width: 12 },
      { width: 14 },
      { width: 14 },
      { width: 12 },
      { width: 30 },
    ];
    sheet.views = [{ state: "frozen", ySplit: 4 }];

    // Title
    sheet.mergeCells("A1:M1");
    const titleCell = sheet.getCell("A1");
    titleCell.value = "Yokohama Global Logistics Inventory Report";
    titleCell.font = { size: 18, bold: true, color: { argb: "FFFFFFFF" } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    titleCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2E5A87" },
    };
    sheet.getRow(1).commit();

    // Subtitle
    sheet.mergeCells("A2:M2");
    const subtitleCell = sheet.getCell("A2");
    subtitleCell.value = `Generated on: ${new Date().toLocaleString("en-US", {
      timeZone: "Asia/Tokyo",
    })}`;
    subtitleCell.font = { italic: true, size: 12 };
    subtitleCell.alignment = { horizontal: "center" };
    sheet.getRow(2).commit();

    sheet.addRow([]).commit();

    // Header row
    const headerRow = sheet.addRow([
      "Yard In Date",
      "Yard Out Date",
      "Vessel",
      "Company",
      "User ID",
      "Make/Model",
      "Chassis",
      "Yard",
      "Job #",
      "POD",
      "Status",
      "Storage Days",
      "Total Images",
      "Remarks",
    ]);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4F81BD" },
      };
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
    });
    headerRow.commit();

    // Fetch filtered data
    const cursor = Shipment.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: "users",
          localField: "clientId",
          foreignField: "_id",
          as: "client",
        },
      },
      { $unwind: { path: "$client", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          gateInDate: 1,
          gateOutDate: 1,
          vesselName: 1,
          yard: 1,
          jobNumber: 1,
          pod: 1,
          exportStatus: 1,
          storageDays: 1,
          clientName: "$client.name",
          clientUserId: "$client.userId",
          carMakeModel: "$carId.makeModel",
          carChassisNumber: "$carId.chassisNumber",
          totalImages: { $size: "$carId.images" },
          remarks: 1,
        },
      },
    ]).cursor({ batchSize: 500 });

    let total = 0;
    for await (const s of cursor) {
      const row = sheet.addRow([
        s.gateInDate ? s.gateInDate.toISOString().split("T")[0] : "",
        s.gateOutDate ? s.gateOutDate.toISOString().split("T")[0] : "",
        s.vesselName || "",
        s.clientName || "",
        s.clientUserId || "",
        s.carMakeModel || "",
        s.carChassisNumber || "",
        s.yard || "",
        s.jobNumber || "",
        s.pod || "",
        s.exportStatus || "",
        s.storageDays || "",
        s.totalImages || 0,
        s.remarks || "",
      ]);
      row.commit();
      total++;
    }

    // Summary row
    const summaryRow = sheet.addRow([
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      `Total: ${total} records`,
    ]);
    summaryRow.font = { bold: true };
    summaryRow.commit();

    sheet.commit();
    await workbook.commit();
  } catch (err) {
    console.error(err);
    if (!res.headersSent)
      return res.status(500).json({ error: "Excel export failed" });
  }
});

// if (dateFrom || dateTo) {
//   const fromDate = dateFrom ? new Date(dateFrom) : null;
//   const toDate = dateTo ? new Date(dateTo) : null;

//   if (fromDate) fromDate.setHours(0, 0, 0, 0);
//   if (toDate) toDate.setHours(23, 59, 59, 999);

//   const dateConditions = [];

//   if (fromDate && toDate) {
//     // Both from/to provided
//     dateConditions.push({
//       $or: [
//         // Both gateIn and gateOut in range
//         {
//           gateInDate: { $gte: fromDate, $lte: toDate },
//           gateOutDate: { $ne: null, $gte: fromDate, $lte: toDate },
//         },
//         // Only gateIn in range, gateOut null
//         {
//           gateInDate: { $gte: fromDate, $lte: toDate },
//           gateOutDate: null,
//         },
//       ],
//     });
//   } else if (fromDate) {
//     // Only fromDate
//     dateConditions.push({
//       gateInDate: { $gte: fromDate },
//       $or: [{ gateOutDate: { $gte: fromDate } }, { gateOutDate: null }],
//     });
//   } else if (toDate) {
//     // Only toDate
//     dateConditions.push({
//       gateInDate: { $lte: toDate },
//       $or: [{ gateOutDate: { $lte: toDate } }, { gateOutDate: null }],
//     });
//   }

//   if (dateConditions.length) {
//     filter.$and = filter.$and || [];
//     filter.$and.push(...dateConditions);
//   }
// }

// ---- CHASSIS FILTER ----
// if (chassisNumber && chassisNumber.trim()) {
//   const term = escapeRegex(chassisNumber.trim());
//   filter.$or = [
//     // { chassisNumber: { $regex: `^${term}`, $options: "i" } },
//     { chassisNumber: { $regex: `${term}$`, $options: "i" } },
//   ];
// }

/**
 * Get shipment by ID
 * OPTIMIZED: Using aggregation with simple $lookup for fast client info join
 */
exports.getShipmentById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest("Invalid shipment ID format");
  }

  // OPTIMIZED: Use aggregation with simple $lookup - faster than populate()
  // Single query with database-level join (like SQL JOIN)
  const pipeline = [
    // Match the specific shipment by ID
    {
      $match: {
        _id: new mongoose.Types.ObjectId(id),
      },
    },
    // Simple $lookup to get client info (name, userId)
    {
      $lookup: {
        from: "users", // Collection name (MongoDB uses lowercase plural)
        localField: "clientId",
        foreignField: "_id",
        as: "client",
        pipeline: [
          {
            $project: {
              name: 1,
              userId: 1,
              email: 1,
              role: 1,
            },
          },
        ],
      },
    },
    // Unwind client array to object (single client per shipment)
    {
      $unwind: {
        path: "$client",
        preserveNullAndEmptyArrays: true, // Keep shipment even if no client
      },
    },
    // Project final structure with client info
    {
      $project: {
        // Shipment fields
        clientId: 1, // Keep original ObjectId reference for saving
        gateInDate: 1,
        gateOutDate: 1,
        vesselName: 1,
        yard: 1,
        pod: 1,
        jobNumber: 1,
        storageDays: 1,
        exportStatus: 1,
        chassisNumber: 1,
        chassisNumberReversed: 1,
        remarks: 1,
        createdAt: 1,
        updatedAt: 1,
        // Car info
        carId: {
          makeModel: "$carId.makeModel",
          chassisNumber: "$carId.chassisNumber",
          images: {
            $map: {
              input: { $ifNull: ["$carId.images", []] },
              as: "img",
              in: {
                _id: "$$img._id",
                url: "$$img.url",
                alt: { $ifNull: ["$$img.alt", "Car photo"] },
                key: "$$img.key",
                name: "$$img.name",
              },
            },
          },
        },
        // Client info from lookup - add to clientId object for frontend compatibility
        // Frontend expects clientId.name and clientId.userId
        clientInfo: {
          name: "$client.name",
          userId: "$client.userId",
          email: "$client.email",
          role: "$client.role",
        },
      },
    },
    // Add client info to clientId object for frontend compatibility
    {
      $addFields: {
        clientId: {
          $cond: {
            if: { $ne: ["$clientInfo.name", null] },
            then: {
              _id: "$clientId",
              name: "$clientInfo.name",
              userId: "$clientInfo.userId",
              email: "$clientInfo.email",
              role: "$clientInfo.role",
            },
            else: "$clientId", // Keep original ObjectId if no client found
          },
        },
      },
    },
    // Remove temporary clientInfo field
    {
      $project: {
        clientInfo: 0,
      },
    },
  ];

  const result = await Shipment.aggregate(pipeline);

  if (!result || result.length === 0) {
    throw ApiError.notFound("Shipment not found");
  }

  const shipment = result[0];

  const response = ApiResponse.success(
    "Shipment retrieved successfully",
    shipment
  );

  res.status(response.statusCode).json(response);
});
