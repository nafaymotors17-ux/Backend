const Vessel = require("../models/vessel.model");
const ApiError = require("../utils/api.error");
const ApiResponse = require("../utils/api.response");
const asyncHandler = require("../utils/asyncHandler");
const mongoose = require("mongoose");
const escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// List vessels with search and pagination
exports.listVessels = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));

  // Build filter
  const filter = {};
  if (search && search.trim()) {
    const searchRegex = { $regex: escapeRegex(search.trim()), $options: "i" };
    filter.$or = [
      { vesselName: searchRegex },
      { jobNumber: searchRegex },
      { shippingLine: searchRegex },
      { pod: searchRegex },
    ];
  }

  // Sort
  const allowedSortFields = ["vesselName", "jobNumber", "etd", "createdAt"];
  const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
  const sortOptions = { [safeSortBy]: sortOrder === "desc" ? -1 : 1 };

  const skip = (pageNum - 1) * limitNum;

  // Get total count
  const totalItems = await Vessel.countDocuments(filter);

  // Fetch vessels
  const vessels = await Vessel.find(filter)
    .sort(sortOptions)
    .skip(skip)
    .limit(limitNum)
    .lean();

  const response = ApiResponse.paginated(
    "Vessels retrieved successfully",
    vessels,
    {
      currentPage: pageNum,
      totalPages: Math.ceil(totalItems / limitNum),
      totalItems,
      itemsPerPage: limitNum,
      hasNextPage: pageNum * limitNum < totalItems,
      hasPrevPage: pageNum > 1,
      sortBy: safeSortBy,
      sortOrder: sortOrder,
    }
  );

  res.status(200).json(response);
});

// Create vessel
exports.createVessel = asyncHandler(async (req, res) => {
  const { vesselName, jobNumber, etd, shippingLine, pod } = req.body;

  if (!vesselName || !vesselName.trim()) {
    throw ApiError.badRequest("Vessel name is required");
  }

  // Check for duplicate vesselName + jobNumber combination
  const existingVessel = await Vessel.findOne({
    vesselName: vesselName.trim().toUpperCase(),
    ...(jobNumber ? { jobNumber: jobNumber.trim().toUpperCase() } : {}),
  });

  if (existingVessel) {
    throw ApiError.conflict(
      "A vessel with this name and job number already exists"
    );
  }

  const vesselData = {
    vesselName: vesselName.trim().toUpperCase(),
  };

  if (jobNumber) vesselData.jobNumber = jobNumber.trim().toUpperCase();
  if (etd) vesselData.etd = new Date(etd);
  if (shippingLine) vesselData.shippingLine = shippingLine.trim().toUpperCase();
  if (pod) vesselData.pod = pod.trim().toUpperCase();

  const vessel = new Vessel(vesselData);
  await vessel.save();

  const response = ApiResponse.created("Vessel created successfully", vessel);
  res.status(response.statusCode).json(response);
});

// Get vessel by ID
exports.getVesselById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest("Invalid vessel ID format");
  }

  const vessel = await Vessel.findById(id);

  if (!vessel) {
    throw ApiError.notFound("Vessel not found");
  }

  const response = ApiResponse.success("Vessel retrieved successfully", vessel);
  res.status(response.statusCode).json(response);
});

// Update vessel
exports.updateVessel = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { vesselName, jobNumber, etd, shippingLine, pod } = req.body;

  const vessel = await Vessel.findById(id);
  if (!vessel) {
    throw ApiError.notFound("Vessel not found");
  }

  // Check for duplicate if vesselName or jobNumber is being changed
  if (vesselName || jobNumber) {
    const checkVesselName = vesselName
      ? vesselName.trim().toUpperCase()
      : vessel.vesselName;
    const checkJobNumber = jobNumber
      ? jobNumber.trim().toUpperCase()
      : vessel.jobNumber;

    const existingVessel = await Vessel.findOne({
      vesselName: checkVesselName,
      jobNumber: checkJobNumber,
      _id: { $ne: id },
    });

    if (existingVessel) {
      throw ApiError.conflict(
        "A vessel with this name and job number already exists"
      );
    }
  }

  if (vesselName) vessel.vesselName = vesselName.trim().toUpperCase();
  if (jobNumber !== undefined)
    vessel.jobNumber = jobNumber ? jobNumber.trim().toUpperCase() : undefined;
  if (etd !== undefined) vessel.etd = etd ? new Date(etd) : null;
  if (shippingLine !== undefined)
    vessel.shippingLine = shippingLine
      ? shippingLine.trim().toUpperCase()
      : undefined;
  if (pod !== undefined)
    vessel.pod = pod ? pod.trim().toUpperCase() : undefined;

  await vessel.save();

  const response = ApiResponse.success("Vessel updated successfully", vessel);
  res.status(response.statusCode).json(response);
});

// Delete vessel
exports.deleteVessel = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const vessel = await Vessel.findByIdAndDelete(id);
  if (!vessel) {
    throw ApiError.notFound("Vessel not found");
  }

  const response = ApiResponse.success("Vessel deleted successfully", {
    _id: vessel._id,
  });
  res.status(response.statusCode).json(response);
});

// Search vessels (for dropdown/autocomplete)
exports.searchVessels = asyncHandler(async (req, res) => {
  const { q, limit = 20 } = req.query;

  if (!q || !q.trim()) {
    return res.status(200).json(ApiResponse.success("Vessels retrieved", []));
  }

  const searchRegex = { $regex: escapeRegex(q.trim()), $options: "i" };
  const vessels = await Vessel.find({
    $or: [
      { vesselName: searchRegex },
      { jobNumber: searchRegex },
      { shippingLine: searchRegex },
    ],
  })
    .limit(parseInt(limit, 10))
    .select("vesselName jobNumber etd shippingLine pod")
    .lean();

  res.status(200).json(ApiResponse.success("Vessels retrieved", vessels));
});
