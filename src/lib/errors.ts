import { ConvexError } from "convex/values";

export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string")
    return error.data;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please retry.";
}
