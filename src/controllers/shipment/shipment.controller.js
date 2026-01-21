const Shipment = require("../../models/shipment.model.js");
const ApiError = require("../../utils/api.error");
const ApiResponse = require("../../utils/api.response");
const asyncHandler = require("../../utils/asyncHandler");
const mongoose = require("mongoose");
const Vessel = require("../../models/vessel.model.js");
const { getCloudFrontUrl, addImageUrls } = require("../../utils/cloudfront");
// const triggerDeletePhotos = require("../../aws/lambda/deleteCarPhotos");
const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // safe regex escape
const { calculateStoragePeriod } = require("../../utils/storage.days.calc.js");
const { deletePhotosFromS3 } = require("../../utils/s3DeleteHelper.js");

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
    pod,
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

  // Vessel filtering - find matching vessel IDs first (FAST - uses indexed vesselId)
  // This is faster than doing lookup on all shipments
  if (vesselName && vesselName.trim()) {
    const vesselNameRegex = {
      $regex: escapeRegex(vesselName.trim()),
      $options: "i",
    };
    const matchingVessels = await Vessel.find(
      { vesselName: vesselNameRegex },
      { _id: 1 }
    ).lean();
    const vesselIds = matchingVessels.map((v) => v._id);
    if (vesselIds.length > 0) {
      filter.vesselId = { $in: vesselIds };
    } else {
      // No vessels found - return empty results
      filter.vesselId = { $in: [] };
    }
  }

  // Job number and POD filtering - find matching vessel IDs first
  const vesselFilterConditions = {};
  if (jobNumber && jobNumber.trim()) {
    vesselFilterConditions.jobNumber = {
      $regex: escapeRegex(jobNumber.trim()),
      $options: "i",
    };
  }
  if (pod && pod.trim()) {
    vesselFilterConditions.pod = {
      $regex: escapeRegex(pod.trim()),
      $options: "i",
    };
  }

  // If we have vessel filter conditions, find matching vessels
  if (Object.keys(vesselFilterConditions).length > 0) {
    const matchingVessels = await Vessel.find(vesselFilterConditions, {
      _id: 1,
    }).lean();
    const vesselIds = matchingVessels.map((v) => v._id);
    if (vesselIds.length > 0) {
      // If vesselName filter already exists, combine with AND (intersect)
      if (filter.vesselId && filter.vesselId.$in) {
        const existingIds = filter.vesselId.$in;
        filter.vesselId = {
          $in: vesselIds.filter((id) =>
            existingIds.some((eid) => eid.toString() === id.toString())
          ),
        };
      } else {
        filter.vesselId = { $in: vesselIds };
      }
    } else {
      // No vessels found - return empty results
      filter.vesselId = { $in: [] };
    }
  }

  if (exportStatus) filter.exportStatus = exportStatus;
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
    "vessel.vesselName", // Vessel entity
    "vessel.jobNumber", // Vessel entity
    "vessel.pod", // Vessel entity
    "yard",
    "exportStatus",
    "storageDays",
  ];

  const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
  const normalizedSortOrder = ["asc", "desc"].includes(sortOrder)
    ? sortOrder
    : "desc";

  // -------------------- FETCH DATA --------------------
  const skip = (pageNum - 1) * limitNum;

  // -------------------- OPTIMIZED AGGREGATION PIPELINE --------------------
  const pipeline = [];

  // 1. Match with filters (vesselId filtering already done above - FAST!)
  pipeline.push({ $match: filter });

  // 2. Check if we need vessel lookup for sorting
  const needsVesselLookupForSort =
    safeSortBy === "vessel.vesselName" ||
    safeSortBy === "vessel.jobNumber" ||
    safeSortBy === "vessel.pod";

  // 3. Sorting - only do vessel lookup if sorting by vessel fields
  if (needsVesselLookupForSort) {
    // For vessel sorting: lookup vessel, sort, then paginate
    pipeline.push({
      $lookup: {
        from: "vessels",
        localField: "vesselId",
        foreignField: "_id",
        as: "vessel",
      },
    });
    pipeline.push({
      $unwind: {
        path: "$vessel",
        preserveNullAndEmptyArrays: true,
      },
    });
    pipeline.push({
      $addFields: {
        sortVesselName: "$vessel.vesselName",
        sortVesselJobNumber: "$vessel.jobNumber",
        sortVesselPod: "$vessel.pod",
      },
    });
    pipeline.push({
      $sort: (() => {
        const sortOpts = {};
        if (safeSortBy === "vessel.vesselName") {
          sortOpts.sortVesselName = normalizedSortOrder === "asc" ? 1 : -1;
        } else if (safeSortBy === "vessel.jobNumber") {
          sortOpts.sortVesselJobNumber = normalizedSortOrder === "asc" ? 1 : -1;
        } else if (safeSortBy === "vessel.pod") {
          sortOpts.sortVesselPod = normalizedSortOrder === "asc" ? 1 : -1;
        }
        sortOpts.createdAt = -1; // Secondary sort
        return sortOpts;
      })(),
    });
  } else {
    // For all other sorts: sort on indexed fields first (FAST!), then paginate
    pipeline.push({
      $sort: (() => {
        const sortOpts = {};
        sortOpts[safeSortBy] = normalizedSortOrder === "asc" ? 1 : -1;
        sortOpts.createdAt = -1; // Secondary sort
        return sortOpts;
      })(),
    });
  }

  // 4. Facet to get both count and paginated data
  pipeline.push({
    $facet: {
      metadata: [{ $count: "totalItems" }],
      data: [
        { $skip: skip },
        { $limit: limitNum },

        // Now do lookups ONLY on paginated results (much faster!)
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
        // Only lookup vessel if we didn't already do it for sorting
        ...(needsVesselLookupForSort
          ? []
          : [
              {
                $lookup: {
                  from: "vessels",
                  localField: "vesselId",
                  foreignField: "_id",
                  as: "vessel",
                },
              },
              {
                $unwind: {
                  path: "$vessel",
                  preserveNullAndEmptyArrays: true,
                },
              },
            ]),

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
        // Format the response - use vessel data from lookup
        {
          $project: {
            // Shipment fields
            gateInDate: 1,
            gateOutDate: 1,
            vesselId: 1,
            yard: 1,
            // jobNumber removed - now in vessel entity
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

            // Vessel fields - use vessel data from entity
            vessel: {
              _id: "$vessel._id",
              vesselName: "$vessel.vesselName",
              jobNumber: "$vessel.jobNumber",
              etd: "$vessel.etd",
              shippingLine: "$vessel.shippingLine",
              pod: "$vessel.pod",
            },
            // Remove sort fields if they exist
            ...(needsVesselLookupForSort
              ? {
                  sortVesselName: "$$REMOVE",
                  sortVesselJobNumber: "$$REMOVE",
                  sortVesselPod: "$$REMOVE",
                }
              : {}),
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
      currentPage: pageNum,
      totalPages: Math.ceil(totalItems / limitNum),
      totalItems,
      itemsPerPage: limitNum,
      hasNextPage: pageNum * limitNum < totalItems,
      hasPrevPage: pageNum > 1,
      sortBy: safeSortBy,
      sortOrder: normalizedSortOrder,
    }
  );

  res.status(200).json(response);
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
      vesselId, // Use vesselId
      yard,
      // glNumber,
      // jobNumber removed - now in vessel entity
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

    // Use vesselId if provided
    if (vesselId && mongoose.Types.ObjectId.isValid(vesselId)) {
      const vessel = await Vessel.findById(vesselId);
      if (vessel) {
        shipmentData.vesselId = vessel._id;
      } else {
        throw ApiError.notFound("Vessel not found");
      }
    }

    if (yard) shipmentData.yard = yard;
    // if (job) shipmentData.glNumber = glNumber;
    // jobNumber removed - now in vessel entity
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
    return res
      .status(201)
      .json(ApiResponse.created("Shipment created successfully", populated));
  } catch (err) {
    throw ApiError.badRequest(err.message || "Failed to create shipment");
  }
});

/**
 * Validate bulk shipments - check chassis uniqueness
 */
exports.validateBulkShipments = asyncHandler(async (req, res) => {
  try {
    const { chassisNumbers } = req.body;

    if (!Array.isArray(chassisNumbers) || chassisNumbers.length === 0) {
      throw ApiError.badRequest("chassisNumbers array is required and must not be empty");
    }

    if (chassisNumbers.length > 100) {
      throw ApiError.badRequest("Cannot validate more than 100 chassis numbers at once");
    }

    // Normalize chassis numbers (uppercase, trim) and track original indices
    const normalizedChassisWithIndex = chassisNumbers.map((chassis, originalIndex) => ({
      originalIndex: originalIndex + 1,
      normalized: chassis ? chassis.trim().toUpperCase() : null,
    })).filter((item) => item.normalized);

    const normalizedChassis = normalizedChassisWithIndex.map((item) => item.normalized);

    // Check for duplicates within the request
    const duplicatesInRequest = [];
    const seen = new Map(); // Map chassis -> first occurrence index
    normalizedChassisWithIndex.forEach((item) => {
      const { originalIndex, normalized } = item;
      if (seen.has(normalized)) {
        // This is a duplicate
        duplicatesInRequest.push({
          index: originalIndex,
          chassisNo: normalized,
          error: "Duplicate chassis number in request",
        });
        // Also mark the first occurrence if not already marked
        const firstIndex = seen.get(normalized);
        if (firstIndex !== originalIndex) {
          const alreadyMarked = duplicatesInRequest.some(
            (e) => e.index === firstIndex && e.chassisNo === normalized
          );
          if (!alreadyMarked) {
            duplicatesInRequest.push({
              index: firstIndex,
              chassisNo: normalized,
              error: "Duplicate chassis number in request",
            });
          }
        }
      } else {
        seen.set(normalized, originalIndex);
      }
    });

    // Check for existing chassis numbers in database
    const existingShipments = await Shipment.find({
      chassisNumber: { $in: normalizedChassis },
    }).select("chassisNumber").lean();

    const existingChassisSet = new Set(
      existingShipments.map((s) => s.chassisNumber)
    );

    const duplicatesInDB = [];
    normalizedChassisWithIndex.forEach((item) => {
      const { originalIndex, normalized } = item;
      if (existingChassisSet.has(normalized)) {
        duplicatesInDB.push({
          index: originalIndex,
          chassisNo: normalized,
          error: `Chassis number "${normalized}" already exists in database`,
        });
      }
    });

    const allErrors = [...duplicatesInRequest, ...duplicatesInDB];
    const isValid = allErrors.length === 0;

    return res.status(200).json({
      success: isValid,
      message: isValid
        ? "All chassis numbers are unique and available"
        : "Some chassis numbers are duplicates or already exist",
      data: {
        isValid,
        errors: allErrors,
        totalChecked: normalizedChassis.length,
        errorCount: allErrors.length,
      },
    });
  } catch (err) {
    throw ApiError.badRequest(err.message || "Failed to validate bulk shipments");
  }
});

/**
 * Bulk create shipments (assumes validation already done and clientId is guaranteed)
 */
exports.createBulkShipments = asyncHandler(async (req, res) => {
  try {
    const { shipments: shipmentsData } = req.body;

    if (!Array.isArray(shipmentsData) || shipmentsData.length === 0) {
      throw ApiError.badRequest("shipments array is required and must not be empty");
    }

    if (shipmentsData.length > 100) {
      throw ApiError.badRequest("Cannot create more than 100 shipments at once");
    }

    const results = {
      successful: [],
      failed: [],
    };

    // Prepare all shipment documents for bulk insert
    const shipmentDocuments = [];
    
    // First pass: validate and prepare documents
    for (let i = 0; i < shipmentsData.length; i++) {
      const shipmentData = shipmentsData[i];
      const {
        customerId,
        carName,
        chassisNo,
        gateInDate,
        gateOutDate,
        yard,
        exportStatus = "pending",
        remarks,
      } = shipmentData;

      // Validation (clientId is guaranteed after validation step)
      if (!chassisNo || !gateInDate) {
        results.failed.push({
          index: i + 1,
          chassisNo: chassisNo || "N/A",
          error: "chassisNo and gateInDate are required",
        });
        continue;
      }

      if (!customerId || !customerId._id) {
        results.failed.push({
          index: i + 1,
          chassisNo: chassisNo || "N/A",
          error: "customerId._id is required",
        });
        continue;
      }

      const chassisNumber = chassisNo.trim().toUpperCase();
      // Calculate reverse chassis (like pre-save hook does for single shipment)
      const chassisNumberReversed = chassisNumber.split("").reverse().join("");
      const gateIn = new Date(gateInDate);
      const gateOut = gateOutDate ? new Date(gateOutDate) : null;

      if (gateOut && gateOut < gateIn) {
        results.failed.push({
          index: i + 1,
          chassisNo: chassisNumber,
          error: "Gate out date cannot be earlier than gate in date",
        });
        continue;
      }

      if (!VALID_EXPORT_STATUSES.includes(exportStatus)) {
        results.failed.push({
          index: i + 1,
          chassisNo: chassisNumber,
          error: "Invalid export status",
        });
        continue;
      }

      // Build shipment document (matching single shipment creation pattern)
      const newShipmentData = {
        clientId: customerId._id,
        carId: {
          makeModel: carName ? carName.trim().toUpperCase() : undefined,
          chassisNumber,
          images: [],
        },
        chassisNumber,
        chassisNumberReversed, // Add reverse chassis manually (insertMany doesn't trigger pre-save hooks)
        gateInDate: gateIn,
        exportStatus,
        storageDays: gateOut ? calculateStoragePeriod(gateIn, gateOut) : 0,
      };

      if (gateOut) newShipmentData.gateOutDate = gateOut;
      if (yard) newShipmentData.yard = yard;
      if (remarks) newShipmentData.remarks = remarks;

      shipmentDocuments.push({
        index: i + 1,
        chassisNo: chassisNumber,
        data: newShipmentData,
      });
    }

    // Filter out failed documents
    const validDocuments = shipmentDocuments
      .filter((doc) => {
        // Check if this document failed validation
        const failed = results.failed.some((f) => f.index === doc.index);
        return !failed;
      })
      .map((doc) => doc.data);

    // Bulk insert using insertMany
    if (validDocuments.length > 0) {
      try {
        const insertedShipments = await Shipment.insertMany(validDocuments, {
          ordered: false, // Continue inserting even if some fail
        });

        // Map successful insertions back to original indices
        const chassisToDocMap = new Map();
        shipmentDocuments.forEach((doc) => {
          if (!results.failed.some((f) => f.index === doc.index)) {
            chassisToDocMap.set(doc.data.chassisNumber, doc);
          }
        });

        insertedShipments.forEach((shipment) => {
          const doc = chassisToDocMap.get(shipment.chassisNumber);
          if (doc) {
            results.successful.push({
              index: doc.index,
              chassisNo: shipment.chassisNumber,
              shipmentId: shipment._id,
            });
          }
        });
      } catch (err) {
        // Handle bulk insert errors
        if (err.writeErrors && err.writeErrors.length > 0) {
          // Some documents failed, but some may have succeeded
          const failedIndices = new Set();
          
          err.writeErrors.forEach((writeError) => {
            const failedIndex = writeError.index;
            const failedDoc = validDocuments[failedIndex];
            const chassisNo = failedDoc?.chassisNumber || "N/A";
            const originalDoc = shipmentDocuments.find(
              (d) => d.data.chassisNumber === chassisNo
            );
            
            if (originalDoc) {
              failedIndices.add(originalDoc.index);
              results.failed.push({
                index: originalDoc.index,
                chassisNo,
                error: writeError.errmsg || writeError.err?.message || "Failed to create shipment",
              });
            }
          });

          // Add successful ones (those not in failedIndices)
          if (err.insertedDocs && err.insertedDocs.length > 0) {
            err.insertedDocs.forEach((insertedShipment) => {
              const originalDoc = shipmentDocuments.find(
                (d) => d.data.chassisNumber === insertedShipment.chassisNumber
              );
              if (originalDoc && !failedIndices.has(originalDoc.index)) {
                results.successful.push({
                  index: originalDoc.index,
                  chassisNo: insertedShipment.chassisNumber,
                  shipmentId: insertedShipment._id,
                });
              }
            });
          }
        } else {
          // All failed or unexpected error
          validDocuments.forEach((doc) => {
            const originalDoc = shipmentDocuments.find(
              (d) => d.data.chassisNumber === doc.chassisNumber
            );
            if (originalDoc) {
              results.failed.push({
                index: originalDoc.index,
                chassisNo: doc.chassisNumber,
                error: err.message || "Failed to create shipment",
              });
            }
          });
        }
      }
    }

    // Return response
    const response = {
      success: results.failed.length === 0,
      message:
        results.failed.length === 0
          ? `Successfully created ${results.successful.length} shipment(s)`
          : `Created ${results.successful.length} shipment(s), ${results.failed.length} failed`,
      data: {
        successful: results.successful,
        failed: results.failed,
        total: shipmentsData.length,
        successCount: results.successful.length,
        failureCount: results.failed.length,
      },
    };

    const statusCode = results.failed.length === 0 ? 201 : 207; // 207 Multi-Status
    return res.status(statusCode).json(response);
  } catch (err) {
    throw ApiError.badRequest(err.message || "Failed to create bulk shipments");
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
  // console.log("Orignal body : ", originalBody);
  // console.log("Sanitized body : ", sanitizedBody);

  try {
    const { id } = req.params;
    const {
      clientId,
      carName,
      chassisNumber,
      gateInDate,
      gateOutDate,
      vesselId, // Use vesselId
      yard,
      // glNumber,
      // jobNumber removed - now in vessel entity
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

    // --- Vessel Handling - Use vesselId ---
    if (originalBody.hasOwnProperty("vesselId")) {
      if (vesselId && mongoose.Types.ObjectId.isValid(vesselId)) {
        const vessel = await Vessel.findById(vesselId);
        if (vessel) {
          shipment.vesselId = vessel._id;
        } else {
          throw ApiError.notFound("Vessel not found");
        }
      } else if (vesselId === null || vesselId === "") {
        // Allow clearing vessel
        shipment.vesselId = null;
      } else {
        throw ApiError.badRequest("Invalid vessel ID format");
      }
    }

    // --- Optional String Fields (The core fix for "" -> undefined) ---

    // Pattern: if the field was sent in the request, set the shipment property to the
    // sanitized value (non-empty string or undefined). Mongoose will omit `undefined`.
    if (originalBody.hasOwnProperty("yard")) {
      shipment.yard = yard ? yard.trim() : undefined;
    }
    // if (originalBody.hasOwnProperty("glNumber")) {
    //   shipment.glNumber = glNumber ? glNumber.trim() : undefined;
    // }
    // jobNumber removed - now in vessel entity
    if (originalBody.hasOwnProperty("exportStatus")) {
      shipment.exportStatus = exportStatus; // Status is validated separately
    }
    if (originalBody.hasOwnProperty("remarks")) {
      shipment.remarks = remarks ? remarks.trim() : "";
    }

    await shipment.save();

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
    pod,
    inYard,
  } = req.query;

  const filter = {};

  if (clientId) filter.clientId = new mongoose.Types.ObjectId(clientId);
  if (yard) filter.yard = { $regex: escapeRegex(yard), $options: "i" };

  // Vessel filtering - find matching vessel IDs first (same as listShipments)
  if (vesselName && vesselName.trim()) {
    const vesselNameRegex = {
      $regex: escapeRegex(vesselName.trim()),
      $options: "i",
    };
    const matchingVessels = await Vessel.find(
      { vesselName: vesselNameRegex },
      { _id: 1 }
    ).lean();
    const vesselIds = matchingVessels.map((v) => v._id);
    if (vesselIds.length > 0) {
      filter.vesselId = { $in: vesselIds };
    } else {
      filter.vesselId = { $in: [] };
    }
  }

  // Job number and POD filtering - find matching vessel IDs
  const vesselFilterConditions = {};
  if (jobNumber && jobNumber.trim()) {
    vesselFilterConditions.jobNumber = {
      $regex: escapeRegex(jobNumber.trim()),
      $options: "i",
    };
  }
  if (pod && pod.trim()) {
    vesselFilterConditions.pod = {
      $regex: escapeRegex(pod.trim()),
      $options: "i",
    };
  }

  if (Object.keys(vesselFilterConditions).length > 0) {
    const matchingVessels = await Vessel.find(vesselFilterConditions, {
      _id: 1,
    }).lean();
    const vesselIds = matchingVessels.map((v) => v._id);
    if (vesselIds.length > 0) {
      if (filter.vesselId && filter.vesselId.$in) {
        const existingIds = filter.vesselId.$in;
        filter.vesselId = {
          $in: vesselIds.filter((id) =>
            existingIds.some((eid) => eid.toString() === id.toString())
          ),
        };
      } else {
        filter.vesselId = { $in: vesselIds };
      }
    } else {
      filter.vesselId = { $in: [] };
    }
  }

  if (exportStatus) filter.exportStatus = exportStatus;
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
      { width: 14 }, // Yard In Date
      { width: 14 }, // Yard Out Date
      // { width: 24 }, // Vessel ID
      { width: 20 }, // Vessel Name
      { width: 12 }, // ETD
      { width: 12 }, // Job #
      { width: 10 }, // POD
      { width: 18 }, // Shipping Line
      // { width: 20 }, // Vessel Created At
      // { width: 20 }, // Vessel Updated At
      { width: 25 }, // Customer
      { width: 12 }, // User ID
      { width: 25 }, // Make/Model
      { width: 22 }, // Chassis
      { width: 12 }, // Yard
      { width: 18 }, // Status
      { width: 12 }, // Storage Days
      { width: 12 }, // Total Images
      { width: 30 }, // Remarks
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
      // "Vessel ID",
      "Vessel Name",
      "ETD",
      "Job #",
      "POD",
      "Shipping Line",
      // "Vessel Created At",
      // "Vessel Updated At",
      "Customer",
      "User ID",
      "Make/Model",
      "Chassis",
      "Yard",
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

    // Fetch filtered data with vessel lookup
    const exportPipeline = [
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
        $lookup: {
          from: "vessels",
          localField: "vesselId",
          foreignField: "_id",
          as: "vessel",
        },
      },
      {
        $unwind: {
          path: "$vessel",
          preserveNullAndEmptyArrays: true,
        },
      },
      // Vessel filtering already done via vesselId in $match stage above
      // No need for additional vessel filtering here
      {
        $project: {
          gateInDate: 1,
          gateOutDate: 1,
          // vesselId: "$vessel._id",
          vesselName: "$vessel.vesselName",
          etd: "$vessel.etd",
          jobNumber: "$vessel.jobNumber",
          pod: "$vessel.pod",
          shippingLine: "$vessel.shippingLine",
          //vesselCreatedAt: "$vessel.createdAt",
          //vesselUpdatedAt: "$vessel.updatedAt",
          yard: 1,
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
    ];

    const cursor = Shipment.aggregate(exportPipeline).cursor({
      batchSize: 1000,
    });

    let total = 0;
    for await (const s of cursor) {
      const row = sheet.addRow([
        s.gateInDate ? s.gateInDate.toISOString().split("T")[0] : "",
        s.gateOutDate ? s.gateOutDate.toISOString().split("T")[0] : "",
        // s.vesselId ? s.vesselId.toString() : "",
        s.vesselName || "",
        s.etd ? s.etd.toISOString().split("T")[0] : "",
        s.jobNumber || "",
        s.pod || "",
        s.shippingLine || "",
        // s.vesselCreatedAt ? s.vesselCreatedAt.toISOString() : "",
        // s.vesselUpdatedAt ? s.vesselUpdatedAt.toISOString() : "",
        s.clientName || "",
        s.clientUserId || "",
        s.carMakeModel || "",
        s.carChassisNumber || "",
        s.yard || "",
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
      "",
      "",
      "",
      "",
      "",
      `Total: ${total} records`,
      "",
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
        vesselId: 1,
        yard: 1,
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
                key: "$$img.key",
                alt: { $ifNull: ["$$img.alt", "Car photo"] },
                name: "$$img.name",
                // url will be constructed from key in post-processing
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
    // Lookup vessel for vessel data
    {
      $lookup: {
        from: "vessels",
        localField: "vesselId",
        foreignField: "_id",
        as: "vessel",
      },
    },
    {
      $unwind: {
        path: "$vessel",
        preserveNullAndEmptyArrays: true,
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
        // Add vessel data
        vessel: {
          _id: "$vessel._id",
          vesselName: "$vessel.vesselName",
          jobNumber: "$vessel.jobNumber",
          etd: "$vessel.etd",
          shippingLine: "$vessel.shippingLine",
          pod: "$vessel.pod",
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

  // Add CloudFront URLs to images (constructed from keys, not stored URLs)
  if (shipment.carId?.images) {
    shipment.carId.images = addImageUrls(shipment.carId.images);
  }
  // Add ZIP file URL if available
  if (shipment.carId?.zipFileKey) {
    shipment.carId.zipFileUrl = getCloudFrontUrl(shipment.carId.zipFileKey);
  }

  const response = ApiResponse.success(
    "Shipment retrieved successfully",
    shipment
  );

  res.status(response.statusCode).json(response);
});

/**
 * Bulk assign vessel to multiple shipments
 */
exports.bulkAssignVessel = asyncHandler(async (req, res) => {
  const { shipmentIds, vesselId } = req.body;

  if (!Array.isArray(shipmentIds) || shipmentIds.length === 0) {
    throw ApiError.badRequest("Please provide shipment IDs");
  }

  if (!vesselId || !mongoose.Types.ObjectId.isValid(vesselId)) {
    throw ApiError.badRequest("Valid vessel ID is required");
  }

  // Convert shipmentIds to ObjectIds and validate
  const validShipmentIds = shipmentIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (validShipmentIds.length === 0) {
    throw ApiError.badRequest("No valid shipment IDs provided");
  }

  // Verify vessel exists

  const vessel = await Vessel.findById(vesselId);
  if (!vessel) {
    throw ApiError.notFound("Vessel not found");
  }

  // Update shipments
  const result = await Shipment.updateMany(
    { _id: { $in: validShipmentIds } },
    {
      $set: {
        vesselId: vessel._id,
        // Also update vesselName for backward compatibility
        vesselName: vessel.vesselName,
      },
    }
  );

  if (result.matchedCount === 0) {
    throw ApiError.notFound("No shipments found");
  }

  const response = ApiResponse.success(
    `Vessel assigned to ${result.modifiedCount} shipment(s)`,
    {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      vessel: {
        _id: vessel._id,
        vesselName: vessel.vesselName,
      },
    }
  );

  res.status(response.statusCode).json(response);
});

/**
 * Bulk assign gate out date to multiple shipments
 */
exports.bulkAssignGateOutDate = asyncHandler(async (req, res) => {
  const { shipmentIds, gateOutDate } = req.body;

  if (!Array.isArray(shipmentIds) || shipmentIds.length === 0) {
    throw ApiError.badRequest("Please provide shipment IDs");
  }

  if (!gateOutDate) {
    throw ApiError.badRequest("Gate out date is required");
  }

  const gateOut = new Date(gateOutDate);

  // Fetch shipments to calculate storage days
  const shipments = await Shipment.find({ _id: { $in: shipmentIds } });

  if (shipments.length === 0) {
    throw ApiError.notFound("No shipments found");
  }

  // Update each shipment with gate out date and recalculate storage days
  const updatePromises = shipments.map(async (shipment) => {
    const storageDays = shipment.gateInDate
      ? calculateStoragePeriod(shipment.gateInDate, gateOut)
      : 0;

    return Shipment.findByIdAndUpdate(
      shipment._id,
      {
        $set: {
          gateOutDate: gateOut,
          storageDays: storageDays,
        },
      },
      { new: true }
    );
  });

  await Promise.all(updatePromises);

  const response = ApiResponse.success(
    `Gate out date assigned to ${shipments.length} shipment(s)`,
    {
      updatedCount: shipments.length,
      gateOutDate: gateOut,
    }
  );

  res.status(response.statusCode).json(response);
});
