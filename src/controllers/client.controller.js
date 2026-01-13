const Shipment = require("../models/shipment.model");
const Vessel = require("../models/vessel.model");
const ApiError = require("../utils/api.error");
const ApiResponse = require("../utils/api.response");
const asyncHandler = require("../utils/asyncHandler");
const mongoose = require("mongoose");
// --- Utility: escape regex safely ---
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

exports.getMyShipments = async (req, res) => {
  try {
    const customerId = req.user._id;
    const {
      page = 1,
      limit = 10,
      chassisNo,
      status,
      search, // Global search parameter
      dateType,
      dateFrom,
      dateTo,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, parseInt(limit, 10)); // Max 50 items per page for performance

    // --- Build filter ---
    const filter = { clientId: customerId };

    // ✅ Export status filter
    if (status) filter.exportStatus = status.toLowerCase();

    // ✅ GLOBAL SEARCH LOGIC - FIXED
    // Priority: search parameter > chassisNo parameter
    const searchTerm = (search || chassisNo || "").trim();

    if (searchTerm) {
      const regexSearch = new RegExp(searchTerm, "i"); // Case-insensitive

      filter.$or = [
        // Chassis number search (with reversed index)
        ...(searchTerm.length > 2
          ? [
              {
                $or: [
                  { chassisNumber: regexSearch },
                  {
                    chassisNumberReversed: {
                      $regex: `^${searchTerm.split("").reverse().join("")}`,
                      $options: "i",
                    },
                  },
                ],
              },
            ]
          : [{ chassisNumber: regexSearch }]),

        // Car make/model search (assuming carId is populated)
        { "carId.makeModel": regexSearch },
      ];
    }
    // Remove the else if chassisNo block - it's handled above

    // ✅ Date Filter - Dynamic date range based on dateType
    if (dateType && (dateFrom || dateTo)) {
      const dateField = getDateField(dateType); // Helper function to map dateType to DB field

      if (dateField) {
        const dateFilter = {};

        if (dateFrom) {
          dateFilter.$gte = new Date(dateFrom);
        }
        if (dateTo) {
          // Set to end of the day for inclusive range
          const endDate = new Date(dateTo);
          endDate.setHours(23, 59, 59, 999);
          dateFilter.$lte = endDate;
        }

        filter[dateField] = dateFilter;
      }
    }

    // --- Sorting ---
    // Only include fields that actually exist in the shipment model
    const allowedSortFields = [
      "gateInDate",
      "gateOutDate",
      "vessel.vesselName", // Vessel entity
      "yard",
      "createdAt",
      // Note: shippedDate and eta don't exist in model, removed
    ];
    const sortField = allowedSortFields.includes(sortBy)
      ? sortBy
      : "gateInDate";
    
    // Check if we need vessel lookup for sorting
    const needsVesselLookupForSort = sortField === "vessel.vesselName";

    console.log(
      `🚀 Fetching shipments page=${pageNum}, limit=${limitNum}, ` +
        `searchTerm="${searchTerm}", ` +
        `(search param="${search || "none"}, chassisNo="${
          chassisNo || "none"
        }) ` +
        `dateType=${dateType || "none"}, ` +
        `dateFrom=${dateFrom || "none"}, dateTo=${dateTo || "none"}`
    );

    // Log the filter for debugging
    console.log("🔍 Filter object:", JSON.stringify(filter, null, 2));

    // --- Build aggregation pipeline for better performance ---
    const pipeline = [
      // Stage 1: Match documents (filtering)
      { $match: filter },
    ];

    // Stage 2: Lookup vessel if needed for sorting or always for data
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

    // Stage 3: Sort documents
    if (needsVesselLookupForSort) {
      pipeline.push({
        $addFields: {
          sortVesselName: "$vessel.vesselName",
        },
      });
      pipeline.push({
        $sort: {
          sortVesselName: sortOrder === "desc" ? -1 : 1,
          createdAt: -1,
        },
      });
    } else {
      pipeline.push({
        $sort: {
          [sortField]: sortOrder === "desc" ? -1 : 1,
          createdAt: -1,
        },
      });
    }

    // Stage 4: Project only needed fields and get only thumbnail (first image)
    pipeline.push({
      $project: {
        // Include all shipment fields
        clientId: 1,
        gateInDate: 1,
        gateOutDate: 1,
        vesselId: 1,
        yard: 1,
        jobNumber: 1,
        storageDays: 1,
        exportStatus: 1,
        chassisNumber: 1,
        chassisNumberReversed: 1,
        remarks: 1,
        createdAt: 1,
        updatedAt: 1,
        // Format carId with only thumbnail (first image) for list view
        carId: {
          makeModel: "$carId.makeModel",
          chassisNumber: "$carId.chassisNumber",
          // Only get first image as thumbnail for list view
          thumbnail: {
            $cond: {
              if: { $gt: [{ $size: { $ifNull: ["$carId.images", []] } }, 0] },
              then: {
                _id: { $arrayElemAt: ["$carId.images._id", 0] },
                url: { $arrayElemAt: ["$carId.images.url", 0] },
                alt: { $arrayElemAt: ["$carId.images.alt", 0] },
              },
              else: null,
            },
          },
          // Include image count for UI display
          imageCount: { $size: { $ifNull: ["$carId.images", []] } },
        },
        // Vessel fields from entity
        vessel: {
          _id: "$vessel._id",
          vesselName: "$vessel.vesselName",
          jobNumber: "$vessel.jobNumber",
          etd: "$vessel.etd",
          shippingLine: "$vessel.shippingLine",
          pod: "$vessel.pod",
        },
        // Remove sort field if it exists
        ...(needsVesselLookupForSort ? { sortVesselName: "$$REMOVE" } : {}),
      },
    });

    // --- Use aggregatePaginate for better performance ---
    const result = await Shipment.aggregatePaginate(
      Shipment.aggregate(pipeline),
      {
        page: pageNum,
        limit: limitNum,
      }
    );

    // --- Prepare response ---
    const data = result.docs;

    const response = {
      status: "success",
      data,
      pagination: {
        currentPage: result.page,
        totalPages: result.totalPages,
        totalItems: result.totalDocs,
        hasNext: result.hasNextPage,
        hasPrev: result.hasPrevPage,
        limit: result.limit,
      },
    };

    console.log(
      `✅ Page ${result.page}/${result.totalPages} fetched (${result.totalDocs} total items)`
    );

    res.status(200).json(response);
  } catch (err) {
    console.error("❌ Error in getMyShipments:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
};

// Helper function to map frontend dateType to DB field
// Only includes fields that actually exist in the shipment model
function getDateField(dateType) {
  const dateFieldMap = {
    createdAt: "createdAt",
    gateInDate: "gateInDate",
    gateOutDate: "gateOutDate",
    // Note: shippedDate and eta don't exist in model, removed
  };

  return dateFieldMap[dateType] || null;
}

/**
 * Get specific shipment by ID for the logged-in customer
 * OPTIMIZED: Using findById with lean() - faster than findOne for ID lookups
 */
exports.getMyShipmentById = async (req, res) => {
  const customerId = req.user._id;
  const { id } = req.params;

  // Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest("Invalid shipment ID format");
  }

  // Use aggregation to include vessel data
  const pipeline = [
    {
      $match: {
        _id: new mongoose.Types.ObjectId(id),
        clientId: customerId,
      },
    },
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
    {
      $project: {
        clientId: 1,
        gateInDate: 1,
        gateOutDate: 1,
        vesselId: 1,
        yard: 1,
        jobNumber: 1,
        storageDays: 1,
        exportStatus: 1,
        chassisNumber: 1,
        chassisNumberReversed: 1,
        remarks: 1,
        createdAt: 1,
        updatedAt: 1,
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
  ];

  const result = await Shipment.aggregate(pipeline);

  if (!result || result.length === 0) {
    throw ApiError.notFound(
      "Shipment not found or you don't have access to this shipment"
    );
  }

  const shipment = result[0];

  const response = ApiResponse.success(
    "Shipment retrieved successfully",
    shipment
  );

  res.status(response.statusCode).json(response);
};

/**
 * Get shipment overview/stats for the logged-in customer
 */
exports.getShipmentOverview = async (req, res) => {
  const customerId = req.user._id;

  // Get total shipments count
  const totalShipments = await Shipment.countDocuments({
    clientId: customerId,
  });

  // Get shipments by status
  const statusCounts = await Shipment.aggregate([
    { $match: { clientId: customerId } },
    { $group: { _id: "$exportStatus", count: { $sum: 1 } } },
  ]);

  // Convert to object format
  const statusOverview = {
    pending: 0,
    exported: 0,
    delayed: 0,
    cancelled: 0,
  };

  statusCounts.forEach((item) => {
    statusOverview[item._id] = item.count;
  });

  // Get recent shipments (last 5) with vessel data
  const recentShipmentsPipeline = [
    { $match: { clientId: customerId } },
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
    {
      $project: {
        vesselId: 1,
        yard: 1,
        gateInDate: 1,
        exportStatus: 1,
        "carId.makeModel": 1,
        vessel: {
          _id: "$vessel._id",
          vesselName: "$vessel.vesselName",
        },
      },
    },
    { $sort: { gateInDate: -1 } },
    { $limit: 5 },
  ];
  const recentShipments = await Shipment.aggregate(recentShipmentsPipeline);

  // Get shipments by vessel (top 5) - using vessel entity
  const vesselStats = await Shipment.aggregate([
    { $match: { clientId: customerId } },
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
    {
      $group: {
        _id: "$vessel.vesselName",
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // Get shipments by yard location (top 5)
  const yardStats = await Shipment.aggregate([
    { $match: { clientId: customerId } },
    { $group: { _id: "$yard", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  const overviewData = {
    summary: {
      totalShipments,
      ...statusOverview,
    },
    recentShipments,
    vesselStats,
    yardStats,
  };

  const response = ApiResponse.success(
    "Shipment overview retrieved successfully",
    overviewData
  );

  res.status(response.statusCode).json(response);
};

// controllers/customerShipment.controller.js
const ExcelJS = require("exceljs");

exports.exportMyShipmentsExcel = asyncHandler(async (req, res) => {
  const customerId = new mongoose.Types.ObjectId(req.params.customerId);
  const { chassisNo, status, search, dateType, dateFrom, dateTo } = req.query;

  // ✅ Build filter EXACTLY like getMyShipments
  const filter = { clientId: customerId };

  // ✅ Export status filter - EXACTLY like getMyShipments
  if (status) filter.exportStatus = status.toLowerCase();

  // ✅ GLOBAL SEARCH LOGIC - EXACT COPY from getMyShipments
  // Priority: search parameter > chassisNo parameter
  const searchTerm = (search || chassisNo || "").trim();

  if (searchTerm) {
    const regexSearch = new RegExp(searchTerm, "i"); // Case-insensitive

    filter.$or = [
      // Chassis number search (with reversed index) - EXACTLY like getMyShipments
      ...(searchTerm.length > 2
        ? [
            {
              $or: [
                { chassisNumber: regexSearch },
                {
                  chassisNumberReversed: {
                    $regex: `^${searchTerm.split("").reverse().join("")}`,
                    $options: "i",
                  },
                },
              ],
            },
          ]
        : [{ chassisNumber: regexSearch }]),

      // Car make/model search - FIXED: carId is embedded object
      { "carId.makeModel": regexSearch },
    ];
  }

  // ✅ Date Filter - EXACTLY like getMyShipments
  if (dateType && (dateFrom || dateTo)) {
    const dateField = getDateField(dateType); // Use the SAME helper function

    if (dateField) {
      const dateFilter = {};

      if (dateFrom) {
        dateFilter.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        // Set to end of the day for inclusive range
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        dateFilter.$lte = endDate;
      }

      filter[dateField] = dateFilter;
    }
  }

  // Log the export filter for debugging
  console.log("📤 Export filter:", JSON.stringify(filter, null, 2));
  console.log("📤 Export parameters:", {
    search,
    chassisNo,
    status,
    dateType,
    dateFrom,
    dateTo,
    customerId,
  });

  try {
    // HTTP headers
    const dateStamp = new Date().toISOString().split("T")[0];

    // Create filename with filter info
    let filename = `my_shipments_${dateStamp}`;
    if (searchTerm) filename += `_search_${searchTerm.substring(0, 20)}`;
    if (status) filename += `_${status}`;
    if (dateType) filename += `_${dateType}`;

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}.xlsx"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
      useSharedStrings: true,
    });

    const sheet = workbook.addWorksheet("My Shipments");

    // Columns
    sheet.columns = [
      { header: "Gate In Date", key: "gateInDate", width: 14 },
      { header: "Gate Out Date", key: "gateOutDate", width: 14 },
      { header: "Vessel", key: "vesselName", width: 20 },
      { header: "Make/Model", key: "makeModel", width: 25 },
      { header: "Yard", key: "yard", width: 12 },
      { header: "Chassis No", key: "chassisNumber", width: 22 },
      { header: "POD", key: "pod", width: 10 },
      { header: "Status", key: "exportStatus", width: 18 },
      { header: "Storage Days", key: "storageDays", width: 12 },
      { header: "Total Images", key: "totalImages", width: 12 },
    ];

    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const sortOptions = { gateInDate: 1 };
    // ✅ Use aggregation with vessel lookup for export
    const pipeline = [
      { $match: filter },
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
      {
        $project: {
          gateInDate: 1,
          gateOutDate: 1,
          yard: 1,
          chassisNumber: 1,
          exportStatus: 1,
          storageDays: 1,
          "carId.makeModel": 1,
          "carId.images": 1,
          vesselName: "$vessel.vesselName",
          pod: "$vessel.pod",
        },
      },
      { $sort: sortOptions },
    ];

    const cursor = Shipment.aggregate(pipeline).cursor({ batchSize: 500 });

    let total = 0;
    for await (const s of cursor) {
      // Calculate total images from carId.images
      const totalImages = s.carId?.images?.length || 0;
      const makeModel = s.carId?.makeModel || "";

      sheet
        .addRow([
          s.gateInDate ? s.gateInDate.toISOString().split("T")[0] : "",
          s.gateOutDate ? s.gateOutDate.toISOString().split("T")[0] : "",
          s.vesselName || "",
          makeModel,
          s.yard || "",
          s.chassisNumber || "",
          s.pod || "",
          s.exportStatus || "",
          s.storageDays || 0,
          totalImages || 0,
        ])
        .commit();
      total++;
    }

    // Summary row with filter info
    const summaryInfo = [];
    if (searchTerm) summaryInfo.push(`Search: ${searchTerm}`);
    if (status) summaryInfo.push(`Status: ${status}`);
    if (dateType) summaryInfo.push(`Date Filter: ${dateType}`);
    if (dateFrom || dateTo)
      summaryInfo.push(`Date Range: ${dateFrom || ""} to ${dateTo || ""}`);

    if (summaryInfo.length > 0) {
      sheet.addRow(["Filter Summary:"]).commit();
      summaryInfo.forEach((info) => {
        sheet.addRow([info]).commit();
      });
      sheet.addRow([]).commit();
    }

    sheet.addRow([`Total Records: ${total}`]).commit();

    await workbook.commit();

    console.log(`✅ Excel export completed: ${total} records`);
  } catch (err) {
    console.error("❌ Export error:", err);
    if (!res.headersSent) {
      res.status(500).json({ status: "error", message: "Excel export failed" });
    }
  }
});
