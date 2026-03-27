import { CallLog } from "../models/calllog.model.js";
import { SipExtension } from "../models/extension.model.js";
import { AIAgent } from "../models/aiagent.model.js";
import { RateLimit } from "../models/ratelimit.model.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { activeCalls } from "./call.controller.js";

// GET /api/v1/dashboard/stats
const getDashboardStats = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Get user's extensions
  const extensions = await SipExtension.find({ createdBy: userId });
  const extensionNumbers = extensions.map(e => e.extension);

  // Get AI agents count
  const agentsCount = await AIAgent.countDocuments({ createdBy: userId });

  // Get total calls (all time)
  const totalCalls = await CallLog.countDocuments({ 
    extension: { $in: extensionNumbers } 
  });

  // Get active calls count
  let activeCallsCount = 0;
  for (const [, call] of activeCalls.entries()) {
    if (extensionNumbers.includes(call.extension)) {
      activeCallsCount++;
    }
  }

  // Get calls today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  const callsToday = await CallLog.countDocuments({
    extension: { $in: extensionNumbers },
    startedAt: { $gte: todayStart }
  });

  // Get average call duration
  const avgDurationResult = await CallLog.aggregate([
    { 
      $match: { 
        extension: { $in: extensionNumbers },
        status: "ended",
        durationSeconds: { $ne: null }
      } 
    },
    {
      $group: {
        _id: null,
        avgDuration: { $avg: "$durationSeconds" }
      }
    }
  ]);

  const avgCallDuration = avgDurationResult.length > 0 
    ? Math.round(avgDurationResult[0].avgDuration) 
    : 0;

  return res.status(200).json(new ApiResponse(200, {
    totalExtensions: extensions.length,
    totalAgents: agentsCount,
    totalCalls,
    activeCalls: activeCallsCount,
    callsToday,
    avgCallDuration
  }, "Dashboard stats fetched"));
});

// GET /api/v1/dashboard/token-usage
const getTokenUsage = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Get user's extensions
  const extensions = await SipExtension.find({ createdBy: userId });
  const extensionIds = extensions.map(e => e._id);

  // Get rate limits
  const limits = await RateLimit.find({ extensionId: { $in: extensionIds } });

  let totalChatGPTLimit = 0;
  let totalDeepgramLimit = 0;

  limits.forEach(limit => {
    if (limit.chatgpt) {
      totalChatGPTLimit += limit.chatgpt.maxTokensPerHour || 0;
    }
    if (limit.deepgram) {
      totalDeepgramLimit += limit.deepgram.maxTokensPerHour || 0;
    }
  });

  // TODO: Get actual token usage from tracking service
  // For now, calculate based on recent calls
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCalls = await CallLog.countDocuments({
    extension: { $in: extensions.map(e => e.extension) },
    startedAt: { $gte: oneHourAgo },
    status: { $in: ["active", "ended"] }
  });

  // Estimate: ~500 tokens per call for ChatGPT, ~300 for Deepgram
  const estimatedChatGPTUsed = recentCalls * 500;
  const estimatedDeepgramUsed = recentCalls * 300;

  return res.status(200).json(new ApiResponse(200, {
    chatgpt: {
      used: estimatedChatGPTUsed,
      limit: totalChatGPTLimit || 50000
    },
    deepgram: {
      used: estimatedDeepgramUsed,
      limit: totalDeepgramLimit || 50000
    }
  }, "Token usage fetched"));
});

// GET /api/v1/dashboard/recent-calls
const getRecentCalls = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const limit = parseInt(req.query.limit) || 10;

  // Get user's extensions
  const extensions = await SipExtension.find({ createdBy: userId });
  const extensionNumbers = extensions.map(e => e.extension);

  const recentCalls = await CallLog.find({
    extension: { $in: extensionNumbers }
  })
  .sort({ startedAt: -1 })
  .limit(limit)
  .select('callId extension fromNumber toNumber status startedAt endedAt durationSeconds');

  return res.status(200).json(new ApiResponse(200, recentCalls, "Recent calls fetched"));
});

export { getDashboardStats, getTokenUsage, getRecentCalls };
