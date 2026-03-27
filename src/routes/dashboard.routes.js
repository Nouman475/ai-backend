import { Router } from "express";
import { getDashboardStats, getTokenUsage, getRecentCalls } from "../controllers/dashboard.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();
router.use(verifyJWT);

router.route("/stats").get(getDashboardStats);
router.route("/token-usage").get(getTokenUsage);
router.route("/recent-calls").get(getRecentCalls);

export default router;
