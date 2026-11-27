import { MEDIA_POLICY } from "../../shared/ticket-contracts";
import type { PendingMedia } from "./types";

const invalidNameCharacters = /[\\/:*?"<>|\x00-\x1F\x7F]/u;

export function splitAttachmentName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

export function attachmentName(item: Pick<PendingMedia, "file" | "name">) {
  return item.name ?? item.file.name;
}

export function editedAttachmentName(input: string, originalName: string) {
  const { extension } = splitAttachmentName(originalName);
  let stem = input.trim();
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) {
    stem = stem.slice(0, -extension.length).trim();
  }
  if (!stem || stem === "." || stem === ".." || invalidNameCharacters.test(stem)
    || stem.length + extension.length > MEDIA_POLICY.maxFileNameLength) return null;
  return stem + extension;
}

export function suggestedAttachmentName(title: string, label: string, originalName: string) {
  const subject = title.replace(new RegExp(invalidNameCharacters.source, "gu"), " ").replace(/\s+/gu, " ").trim();
  return editedAttachmentName(subject ? `${subject} - ${label}` : label, originalName);
}

/** Remove the source suffix only, including when the chosen stem contains dots. */
export function attachmentStem(name: string, sourceName: string) {
  const { extension } = splitAttachmentName(sourceName);
  return extension ? name.slice(0, -extension.length) : name;
}

export function nameForPreparedAttachment(item: PendingMedia, file: File) {
  if (item.name === undefined) return file.name;
  const { extension } = splitAttachmentName(file.name);
  if (item.file.type === file.type && extension === splitAttachmentName(item.file.name).extension) return item.name;
  return attachmentStem(item.name, item.file.name) + extension;
}
