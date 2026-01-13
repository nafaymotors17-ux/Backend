const Shipment = require("../models/shipment.model");
const Vessel = require("../models/vessel.model");
const ApiError = require("../utils/api.error");
const ApiResponse = require("../utils/api.response");
const asyncHandler = require("../utils/asyncHandler");
const mongoose = require("mongoose");

/**
 * Analyze migration status - shows what needs to be migrated
 */
exports.analyzeMigration = asyncHandler(async (req, res) => {
  // Count shipments with vesselName but no vesselId
  const unmigratedCount = await Shipment.countDocuments({
    vesselName: { $exists: true, $ne: null, $ne: "" },
    vesselId: { $exists: false },
  });

  // Count shipments already migrated
  const migratedCount = await Shipment.countDocuments({
    vesselId: { $exists: true, $ne: null },
  });

  // Get unique vessel combinations from unmigrated shipments
  const uniqueVessels = await Shipment.aggregate([
    {
      $match: {
        vesselName: { $exists: true, $ne: null, $ne: "" },
        vesselId: { $exists: false },
      },
    },
    {
      $group: {
        _id: {
          vesselName: { $toUpper: "$vesselName" },
          jobNumber: { $ifNull: [{ $toUpper: "$jobNumber" }, ""] },
          pod: { $ifNull: [{ $toUpper: "$pod" }, ""] },
        },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        vesselName: "$_id.vesselName",
        jobNumber: "$_id.jobNumber",
        pod: "$_id.pod",
        shipmentCount: "$count",
      },
    },
    { $sort: { shipmentCount: -1 } },
  ]);

  // Count existing vessels
  const existingVesselCount = await Vessel.countDocuments();

  const response = ApiResponse.success("Migration analysis completed", {
    unmigratedShipments: unmigratedCount,
    migratedShipments: migratedCount,
    uniqueVesselCombinations: uniqueVessels.length,
    existingVessels: existingVesselCount,
    vesselCombinations: uniqueVessels,
  });

  res.status(response.statusCode).json(response);
});

/**
 * Execute migration - creates vessels and links shipments
 */
exports.executeMigration = asyncHandler(async (req, res) => {
  const { dryRun = false } = req.query;

  if (dryRun === "true") {
    // Dry run - just analyze what would happen
    const analysis = await Shipment.aggregate([
      {
        $match: {
          vesselName: { $exists: true, $ne: null, $ne: "" },
          vesselId: { $exists: false },
        },
      },
      {
        $group: {
          _id: {
            vesselName: { $toUpper: "$vesselName" },
            jobNumber: { $ifNull: [{ $toUpper: "$jobNumber" }, ""] },
            pod: { $ifNull: [{ $toUpper: "$pod" }, ""] },
          },
          shipmentIds: { $push: "$_id" },
          count: { $sum: 1 },
        },
      },
    ]);

    const response = ApiResponse.success(
      "Dry run completed - no changes made",
      {
        vesselsToCreate: analysis.length,
        totalShipmentsToMigrate: analysis.reduce(
          (sum, v) => sum + v.count,
          0
        ),
        details: analysis.map((v) => ({
          vesselName: v._id.vesselName,
          jobNumber: v._id.jobNumber || null,
          pod: v._id.pod || null,
          shipmentCount: v.count,
        })),
      }
    );

    return res.status(response.statusCode).json(response);
  }

  // Actual migration
  const migrationLog = {
    vesselsCreated: 0,
    shipmentsUpdated: 0,
    errors: [],
    vesselMap: {},
  };

  try {
    // Step 1: Get all unique vessel combinations from unmigrated shipments
    const uniqueVessels = await Shipment.aggregate([
      {
        $match: {
          vesselName: { $exists: true, $ne: null, $ne: "" },
          vesselId: { $exists: false },
        },
      },
      {
        $group: {
          _id: {
            vesselName: { $toUpper: { $trim: { input: "$vesselName" } } },
            jobNumber: {
              $ifNull: [
                { $toUpper: { $trim: { input: "$jobNumber" } } },
                "",
              ],
            },
            pod: {
              $ifNull: [{ $toUpper: { $trim: { input: "$pod" } } }, ""],
            },
          },
          shipmentIds: { $push: "$_id" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Step 2: Create or find vessels for each unique combination
    for (const vesselGroup of uniqueVessels) {
      const vesselName = vesselGroup._id.vesselName;
      const jobNumber = vesselGroup._id.jobNumber || null;
      const pod = vesselGroup._id.pod || null;

      try {
        // Check if vessel already exists
        // Handle both null and empty string for jobNumber
        let vessel;
        if (jobNumber) {
          vessel = await Vessel.findOne({
            vesselName: vesselName,
            jobNumber: jobNumber,
          });
        } else {
          vessel = await Vessel.findOne({
            vesselName: vesselName,
            $or: [{ jobNumber: null }, { jobNumber: "" }, { jobNumber: { $exists: false } }],
          });
        }

        // If not found, create new vessel
        if (!vessel) {
          const vesselData = {
            vesselName: vesselName,
          };
          // Only add jobNumber if it's not empty
          if (jobNumber && jobNumber.trim()) {
            vesselData.jobNumber = jobNumber.trim();
          }
          // Only add pod if it's not empty
          if (pod && pod.trim()) {
            vesselData.pod = pod.trim();
          }
          vessel = new Vessel(vesselData);
          await vessel.save();
          migrationLog.vesselsCreated++;
        }

        // Store mapping for later use
        const key = `${vesselName}_${jobNumber || ""}_${pod || ""}`;
        migrationLog.vesselMap[key] = vessel._id;

        // Step 3: Update all shipments with this vessel combination
        const updateResult = await Shipment.updateMany(
          {
            _id: { $in: vesselGroup.shipmentIds },
            vesselId: { $exists: false },
          },
          {
            $set: {
              vesselId: vessel._id,
            },
          }
        );

        migrationLog.shipmentsUpdated += updateResult.modifiedCount;
      } catch (error) {
        migrationLog.errors.push({
          vesselName,
          jobNumber,
          pod,
          error: error.message,
        });
      }
    }

    const response = ApiResponse.success("Migration completed", migrationLog);
    res.status(response.statusCode).json(response);
  } catch (error) {
    throw ApiError.internalError(
      `Migration failed: ${error.message}`
    );
  }
});

/**
 * Verify migration - checks if migration was successful
 */
exports.verifyMigration = asyncHandler(async (req, res) => {
  // Check for shipments with vesselName but no vesselId
  const unmigrated = await Shipment.countDocuments({
    vesselName: { $exists: true, $ne: null, $ne: "" },
    vesselId: { $exists: false },
  });

  // Check for shipments with vesselId
  const migrated = await Shipment.countDocuments({
    vesselId: { $exists: true, $ne: null },
  });

  // Check for orphaned vesselIds (vesselId exists but vessel doesn't)
  const shipmentsWithVesselId = await Shipment.find({
    vesselId: { $exists: true, $ne: null },
  }).select("vesselId").lean();

  const vesselIds = [...new Set(shipmentsWithVesselId.map((s) => s.vesselId))];
  const existingVessels = await Vessel.find({
    _id: { $in: vesselIds },
  }).select("_id").lean();

  const existingVesselIds = new Set(existingVessels.map((v) => v._id.toString()));
  const orphanedCount = vesselIds.filter(
    (id) => !existingVesselIds.has(id.toString())
  ).length;

  // Sample check - verify data integrity
  const sampleSize = Math.min(10, migrated);
  const samples = await Shipment.aggregate([
    {
      $match: {
        vesselId: { $exists: true, $ne: null },
        vesselName: { $exists: true, $ne: null },
      },
    },
    { $sample: { size: sampleSize } },
    {
      $lookup: {
        from: "vessels",
        localField: "vesselId",
        foreignField: "_id",
        as: "vessel",
      },
    },
    {
      $unwind: { path: "$vessel", preserveNullAndEmptyArrays: true },
    },
    {
      $project: {
        shipmentId: "$_id",
        shipmentVesselName: "$vesselName",
        vesselId: "$vesselId",
        vesselVesselName: "$vessel.vesselName",
        match: {
          $eq: [
            { $toUpper: "$vesselName" },
            { $toUpper: "$vessel.vesselName" },
          ],
        },
      },
    },
  ]);

  const mismatches = samples.filter((s) => !s.match).length;

  const response = ApiResponse.success("Migration verification completed", {
    unmigratedShipments: unmigrated,
    migratedShipments: migrated,
    orphanedVesselIds: orphanedCount,
    sampleCheck: {
      samplesChecked: sampleSize,
      mismatches: mismatches,
      samples: samples,
    },
    status:
      unmigrated === 0 && orphanedCount === 0 && mismatches === 0
        ? "PASSED"
        : "ISSUES_FOUND",
  });

  res.status(response.statusCode).json(response);
});

/**
 * Rollback migration - removes vesselId from shipments (keeps vessels)
 */
exports.rollbackMigration = asyncHandler(async (req, res) => {
  const { confirm } = req.query;

  if (confirm !== "true") {
    const count = await Shipment.countDocuments({
      vesselId: { $exists: true, $ne: null },
    });

    return res.status(200).json(
      ApiResponse.success(
        "Rollback preview - add ?confirm=true to execute",
        {
          shipmentsToRollback: count,
          message:
            "This will remove vesselId references from shipments but keep Vessel documents.",
        }
      )
    );
  }

  const result = await Shipment.updateMany(
    { vesselId: { $exists: true, $ne: null } },
    { $unset: { vesselId: "" } }
  );

  const response = ApiResponse.success("Rollback completed", {
    shipmentsRolledBack: result.modifiedCount,
    message: "Vessel documents were not deleted. You can re-run migration.",
  });

  res.status(response.statusCode).json(response);
});

/**
 * Cleanup old fields - removes vesselName, pod, jobNumber from shipments
 * WARNING: This is irreversible! Only run after migration is verified and stable
 */
exports.cleanupOldFields = asyncHandler(async (req, res) => {
  const { confirm, verifyFirst = "true" } = req.query;

  if (verifyFirst === "true") {
    // First verify migration
    const unmigrated = await Shipment.countDocuments({
      vesselName: { $exists: true, $ne: null, $ne: "" },
      vesselId: { $exists: false },
    });

    if (unmigrated > 0) {
      throw ApiError.badRequest(
        `Cannot cleanup: ${unmigrated} shipments are not yet migrated. Run migration first.`
      );
    }
  }

  if (confirm !== "true") {
    const withVesselName = await Shipment.countDocuments({
      vesselName: { $exists: true, $ne: null },
    });
    const withPod = await Shipment.countDocuments({
      pod: { $exists: true, $ne: null },
    });
    const withJobNumber = await Shipment.countDocuments({
      jobNumber: { $exists: true, $ne: null },
    });

    return res.status(200).json(
      ApiResponse.success(
        "Cleanup preview - add ?confirm=true to execute",
        {
          shipmentsWithVesselName: withVesselName,
          shipmentsWithPod: withPod,
          shipmentsWithJobNumber: withJobNumber,
          warning:
            "This will permanently remove vesselName, pod, and jobNumber fields from shipments. This action is IRREVERSIBLE!",
        }
      )
    );
  }

  // Remove old fields
  const result = await Shipment.updateMany(
    {},
    {
      $unset: {
        vesselName: "",
        pod: "",
        jobNumber: "",
      },
    }
  );

  const response = ApiResponse.success("Cleanup completed", {
    shipmentsUpdated: result.modifiedCount,
    message:
      "Old fields (vesselName, pod, jobNumber) have been removed from shipments.",
  });

  res.status(response.statusCode).json(response);
});

