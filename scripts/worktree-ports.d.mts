export type Ports = { CONVEX_CLOUD_PORT: number; CONVEX_SITE_PORT: number; UPLOAD_API_PORT: number; VITE_PORT: number };
export const PORTS_FILE: string;
export const DEFAULT_PORTS: Ports;
export function portsForSlot(slot: number): Ports;
export function readPortsFile(dir?: string): Partial<Ports> | null;
export function loadPorts(dir?: string): Ports;
export function localAppOrigins(ports?: Ports): string;
