import { Elysia } from "elysia";
import { config } from "./config.ts";

export const app = new Elysia().get("/", "Hello World");
