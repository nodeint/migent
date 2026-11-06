import { cell, type Column } from "./render.js";

export const field = (header: string, key: string): Column => ({ header, cell: (view) => cell(view[key]) });

export const count = (header: string, key: string): Column => ({
  header,
  cell: (view) => (Array.isArray(view[key]) ? String((view[key] as unknown[]).length) : "0"),
});
