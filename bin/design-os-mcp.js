#!/usr/bin/env node
/**
 * MCP stdio entry point.
 *
 * A dedicated binary, so an `mcp.json` entry is `command` plus no arguments and
 * cannot be broken by a change to the CLI's argument parsing. `design-os mcp`
 * remains the same server reached the other way.
 *
 * stdout carries MCP messages and nothing else. Commands already send progress
 * to stderr, so that holds without any further care here.
 */

import { serve } from '../src/mcp.js';

process.exitCode = await serve();
