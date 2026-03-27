import { SipExtension } from "../models/extension.model.js";
import { AIAgent } from "../models/aiagent.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// ── In-memory registry of active drachtio SRF instances per extension ────────
// key: extension string  →  value: { srf, req, res }
export const activeSrfSessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/sip/
// Returns all SIP extensions belonging to the logged-in user
// ─────────────────────────────────────────────────────────────────────────────
  const getAllSipExtensions = asyncHandler(async (req, res) => {
    const extensions = await SipExtension.find({ createdBy: req.user._id })
        .populate('aiAgent', 'name purpose modelProvider modelName')
        .select("-password");

    return res
        .status(200)
        .json(new ApiResponse(200, extensions, "Extensions fetched successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/sip/
// Create & register a new SIP extension
// Body: { extension, password, domain, displayName }
// ─────────────────────────────────────────────────────────────────────────────
const createSipExtension = asyncHandler(async (req, res) => {
    const { extension, password, domain, displayName } = req.body;

    if (!extension || !password || !domain) {
        throw new ApiError(400, "extension, password and domain are required");
    }

    const existing = await SipExtension.findOne({ extension });
    if (existing) {
        throw new ApiError(409, `Extension ${extension} already exists`);
    }

    const newExtension = await SipExtension.create({
        extension,
        password,
        domain,
        displayName: displayName || extension,
        createdBy: req.user._id,
    });

    const createdExtension = await SipExtension.findById(newExtension._id).select("-password");

    return res
        .status(201)
        .json(
            new ApiResponse(
                201,
                createdExtension,
                "SIP extension created successfully"
            )
        );
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/sip/:id
// Delete a SIP extension (only if owner)
// ─────────────────────────────────────────────────────────────────────────────
const deleteSipExtension = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const ext = await SipExtension.findOne({ _id: id, createdBy: req.user._id });
    if (!ext) {
        throw new ApiError(404, "Extension not found or unauthorized");
    }

    await SipExtension.findByIdAndDelete(id);

    return res
        .status(200)
        .json(new ApiResponse(200, null, "Extension deleted successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/sip/register
// Trigger SIP REGISTER on the drachtio server for an extension
// Body: { extension }
// ─────────────────────────────────────────────────────────────────────────────
const registerSipExtension = asyncHandler(async (req, res) => {
    const { extension } = req.body;

    if (!extension) throw new ApiError(400, "extension is required");

    const ext = await SipExtension.findOne({
        extension,
        createdBy: req.user._id,
    });
    if (!ext) throw new ApiError(404, "Extension not found");

    // Dynamically import srf from the running realtime module
    let srf;
    try {
        const rtModule = await import("../services/realtime.service.js");
        srf = rtModule.srf;
        if (!srf) {
            throw new ApiError(503, "SIP server not initialized");
        }
    } catch (error) {
        if (error.statusCode) throw error;
        throw new ApiError(503, "SIP server module not available. Make sure drachtio server is running.");
    }

    // Check if already registered and cleanup old registration
    if (activeSrfSessions.has(extension)) {
        console.log(`⚠️ Extension ${extension} already has active session, cleaning up...`);
        const oldSession = activeSrfSessions.get(extension);
        try {
            if (oldSession.req) oldSession.req.cancel();
        } catch (_) {}
        activeSrfSessions.delete(extension);
    }

    await new Promise((resolve, reject) => {
        const registerReq = srf.request(`sip:${ext.domain}`, {
            method: "REGISTER",
            headers: {
                Contact: `<sip:${ext.extension}@${process.env.PUBLIC_IP}:5070>`,
                To: `sip:${ext.extension}@${ext.domain}`,
                From: `sip:${ext.extension}@${ext.domain}`,
            },
            auth: { username: ext.extension, password: ext.password },
        }, (err, request) => {
            if (err) {
                console.error(`❌ REGISTER failed for ${extension}:`, err.message);
                return reject(new ApiError(502, `REGISTER failed: ${err.message}`));
            }
            
            request.on("response", async (sipRes) => {
                if (sipRes.status === 200) {
                    ext.isRegistered = true;
                    ext.registeredAt = new Date();
                    await ext.save();
                    
                    // Store session for cleanup
                    activeSrfSessions.set(extension, { srf, req: request, res: sipRes });
                    
                    console.log(`✅ Extension ${extension} registered successfully`);
                    resolve();
                } else {
                    console.error(`❌ SIP responded ${sipRes.status} ${sipRes.reason}`);
                    reject(new ApiError(502, `SIP responded ${sipRes.status} ${sipRes.reason}`));
                }
            });
            
            request.on("error", (err) => {
                console.error(`❌ REGISTER request error for ${extension}:`, err.message);
                reject(new ApiError(502, `REGISTER request error: ${err.message}`));
            });
        });
    });

    return res
        .status(200)
        .json(new ApiResponse(200, { extension, registered: true }, "Extension registered"));
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/sip/unregister
// Send REGISTER with Expires: 0 to unregister
// Body: { extension }
// ─────────────────────────────────────────────────────────────────────────────
const unregisterSipExtension = asyncHandler(async (req, res) => {
    const { extension } = req.body;

    if (!extension) throw new ApiError(400, "extension is required");

    const ext = await SipExtension.findOne({
        extension,
        createdBy: req.user._id,
    });
    if (!ext) throw new ApiError(404, "Extension not found");

    let srf;
    try {
        const rtModule = await import("../services/realtime.service.js");
        srf = rtModule.srf;
        if (!srf) {
            throw new ApiError(503, "SIP server not initialized");
        }
    } catch (error) {
        if (error.statusCode) throw error;
        throw new ApiError(503, "SIP server module not available. Make sure drachtio server is running.");
    }

    // Cleanup old session first
    if (activeSrfSessions.has(extension)) {
        console.log(`🧹 Cleaning up old session for ${extension}`);
        const oldSession = activeSrfSessions.get(extension);
        try {
            if (oldSession.req) oldSession.req.cancel();
        } catch (_) {}
        activeSrfSessions.delete(extension);
    }

    await new Promise((resolve, reject) => {
        srf.request(`sip:${ext.domain}`, {
            method: "REGISTER",
            headers: {
                Contact: `<sip:${ext.extension}@${process.env.PUBLIC_IP}:5070>;expires=0`,
                To: `sip:${ext.extension}@${ext.domain}`,
                From: `sip:${ext.extension}@${ext.domain}`,
                Expires: "0",
            },
            auth: { username: ext.extension, password: ext.password },
        }, (err, request) => {
            if (err) {
                console.error(`❌ UNREGISTER failed for ${extension}:`, err.message);
                return reject(new ApiError(502, `UNREGISTER failed: ${err.message}`));
            }
            request.on("response", async (sipRes) => {
                ext.isRegistered = false;
                ext.registeredAt = null;
                await ext.save();
                console.log(`✅ Extension ${extension} unregistered successfully`);
                resolve();
            });
            request.on("error", (err) => {
                console.error(`❌ UNREGISTER request error for ${extension}:`, err.message);
                // Still mark as unregistered even if error
                ext.isRegistered = false;
                ext.registeredAt = null;
                ext.save().then(() => resolve()).catch(() => resolve());
            });
        });
    });

    return res
        .status(200)
        .json(new ApiResponse(200, { extension, registered: false }, "Extension unregistered"));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/sip/status
// Get registration status of all extensions for current user
// ─────────────────────────────────────────────────────────────────────────────
const getAllExtensionStatus = asyncHandler(async (req, res) => {
    const extensions = await SipExtension.find({ createdBy: req.user._id }).select(
        "extension domain isRegistered registeredAt displayName"
    );

    return res
        .status(200)
        .json(new ApiResponse(200, extensions, "Status fetched"));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/sip/status/:extension
// Get registration status of a single extension
// ─────────────────────────────────────────────────────────────────────────────
const getExtensionStatus = asyncHandler(async (req, res) => {
    const { extension } = req.params;

    const ext = await SipExtension.findOne({
        extension,
        createdBy: req.user._id,
    }).select("extension domain isRegistered registeredAt displayName");

    if (!ext) throw new ApiError(404, "Extension not found");

    return res
        .status(200)
        .json(new ApiResponse(200, ext, "Extension status fetched"));
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/sip/:id/agent
// Assign an AI agent to an extension
// Body: { agentId }
// ─────────────────────────────────────────────────────────────────────────────
const assignAgent = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { agentId } = req.body;

    if (!agentId) throw new ApiError(400, "agentId is required");

    const [ext, agent] = await Promise.all([
        SipExtension.findOne({ _id: id, createdBy: req.user._id }),
        AIAgent.findOne({ _id: agentId, createdBy: req.user._id }),
    ]);

    if (!ext)   throw new ApiError(404, "Extension not found or unauthorized");
    if (!agent) throw new ApiError(404, "Agent not found or unauthorized");

    ext.aiAgent = agent._id;
    await ext.save();

    return res
        .status(200)
        .json(new ApiResponse(200, { extension: ext.extension, agentId: agent._id, agentName: agent.name }, "Agent assigned to extension"));
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/sip/:id/agent
// Remove the AI agent assignment from an extension
// ─────────────────────────────────────────────────────────────────────────────
const unassignAgent = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const ext = await SipExtension.findOne({ _id: id, createdBy: req.user._id });
    if (!ext) throw new ApiError(404, "Extension not found or unauthorized");

    ext.aiAgent = null;
    await ext.save();

    return res
        .status(200)
        .json(new ApiResponse(200, { extension: ext.extension, agentId: null }, "Agent unassigned from extension"));
});

export {
    getAllSipExtensions,
    createSipExtension,
    deleteSipExtension,
    registerSipExtension,
    unregisterSipExtension,
    getAllExtensionStatus,
    getExtensionStatus,
    assignAgent,
    unassignAgent,
};