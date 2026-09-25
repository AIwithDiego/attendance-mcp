#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDatabase } from "./seed.js";
import { createServer } from "./server.js";

// stdout is the protocol channel, so anything we log goes to stderr.
const db = createDatabase(process.env.ATTENDANCE_DB ?? ":memory:");
const server = createServer(db);
await server.connect(new StdioServerTransport());
console.error("attendance-mcp running on stdio");
