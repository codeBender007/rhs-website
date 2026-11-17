import axios from "axios";
import { getBaseApiUrl } from "../config/env";

/**
 * Sanitize payload so large base64 data URLs on product images cannot trigger 413 Payload Too Large errors.
 */
function sanitizeEnquiryPayload(payload = {}) {
  const rawProducts = Array.isArray(payload.products) ? payload.products : [];
  const sanitizedProducts = rawProducts.map((p) => {
    const rawImage = typeof p?.image === "string" ? p.image : "";
    const safeImage =
      rawImage.startsWith("data:") || rawImage.length > 500 ? "" : rawImage;
    return {
      id: p?.id ?? p?.machine_id ?? 1,
      machine_id: String(p?.machine_id ?? p?.id ?? "1"),
      name: String(
        p?.machine_name || p?.name || payload.machine_name || ""
      ).trim(),
      machine_name: String(
        p?.machine_name || p?.name || payload.machine_name || ""
      ).trim(),
      quantity: Number(p?.quantity) > 0 ? Number(p.quantity) : 1,
      image: safeImage,
    };
  });

  return {
    ...payload,
    products: sanitizedProducts,
  };
}

/**
 * Build candidate API endpoints in priority order:
 * 1. Configured base API URL (`getBaseApiUrl()`, e.g. https://api.rhscare.org/api in production)
 * 2. Alternate backend route on configured base (/queries/machine-query)
 * 3. In local development (Vite dev mode), Vite dev proxy (/api/...) and direct localhost:5000 fallback
 */
function getCandidateEnquiryUrls() {
  const base = getBaseApiUrl();

  const candidates = [
    `${base}/product-enquiries`,
    `${base}/queries/machine-query`,
  ];

  if (import.meta.env?.DEV) {
    const host =
      typeof window !== "undefined" && window.location?.hostname
        ? window.location.hostname
        : "localhost";

    candidates.push(
      "/api/product-enquiries",
      "/api/queries/machine-query",
      `http://${host}:5000/api/product-enquiries`,
      "http://localhost:5000/api/product-enquiries",
      "http://127.0.0.1:5000/api/product-enquiries"
    );
  }

  return Array.from(new Set(candidates));
}

/**
 * Submit a Product Enquiry from the main RHS website to the backend database.
 * Endpoint: POST /api/product-enquiries (with automatic fallback to /api/queries/machine-query)
 *
 * @param {Object} payload
 * @returns {Promise<Object>}
 */
export async function submitProductEnquiry(payload) {
  const cleanPayload = sanitizeEnquiryPayload(payload);
  const candidateUrls = getCandidateEnquiryUrls();
  let lastError = null;

  for (const url of candidateUrls) {
    try {
      const response = await axios.post(url, cleanPayload, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      });

      // Guard: Reject HTML responses (e.g. <!doctype html> served by static SPA hosting fallback)
      if (
        typeof response.data === "string" &&
        response.data.trim().startsWith("<")
      ) {
        throw new Error("Received HTML fallback instead of JSON API response.");
      }

      if (!response.data || response.data.success === false) {
        throw new Error(
          response.data?.message ||
            "Failed to submit product enquiry. Please try again."
        );
      }

      return response.data;
    } catch (error) {
      lastError = error;

      // If the backend responded with a validation error (400), stop and surface it immediately
      if (error?.response?.status === 400) {
        break;
      }
      // If network error, 404, or HTML fallback on this candidate URL, try the next candidate
    }
  }

  const backendMessage = lastError?.response?.data?.message;
  const message =
    backendMessage ||
    lastError?.message ||
    "Unable to submit your product enquiry at this time. Please try again.";
  const err = new Error(message);
  err.response = lastError?.response;
  throw err;
}
