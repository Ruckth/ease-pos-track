export type TicketNumberRow = {
  id: string;
  createdAt: number;
  ticketNumber?: number;
};

export type TicketNumberAssignment = {
  id: string;
  ticketNumber: number;
};

export function isValidTicketNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

export function planTicketNumberBackfill(
  rows: TicketNumberRow[],
  counterNextNumber?: number,
): { assignments: TicketNumberAssignment[]; nextNumber: number } {
  const highestAssigned = rows.reduce(
    (highest, row) => isValidTicketNumber(row.ticketNumber) ? Math.max(highest, row.ticketNumber) : highest,
    0,
  );
  let nextNumber = Math.max(
    highestAssigned + 1,
    isValidTicketNumber(counterNextNumber) ? counterNextNumber : 1,
  );

  const assignments = rows
    .filter((row) => !isValidTicketNumber(row.ticketNumber))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((row) => ({ id: row.id, ticketNumber: nextNumber++ }));

  return { assignments, nextNumber };
}
