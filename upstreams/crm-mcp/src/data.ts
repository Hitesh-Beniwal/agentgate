export type Customer = {
  id: number;
  name: string;
  email: string;
  phone: string;
  state: "VIC" | "NSW" | "QLD" | "WA" | "SA";
  plan: "starter" | "pro" | "enterprise";
  notes: string;
};

export const customers: Customer[] = [
  { id: 1, name: "Jane Citizen",   email: "jane.citizen@example.com",  phone: "0412 345 678", state: "VIC", plan: "pro",        notes: "Prefers email contact." },
  { id: 2, name: "Raj Patel",      email: "raj.patel@example.com",     phone: "0423 456 789", state: "NSW", plan: "enterprise", notes: "Card on file 4111 1111 1111 1111." },
  { id: 3, name: "Mia Nguyen",     email: "mia.nguyen@example.com",    phone: "+61 431 222 333", state: "VIC", plan: "starter", notes: "Renewal due March." },
  { id: 4, name: "Tom O'Brien",    email: "tom.obrien@example.com",    phone: "0400 111 222", state: "QLD", plan: "pro",        notes: "Asked about API access." },
  { id: 5, name: "Aisha Khan",     email: "aisha.khan@example.com",    phone: "0455 666 777", state: "VIC", plan: "enterprise", notes: "Call on (03) 9123 4567 after 2pm." },
  { id: 6, name: "Liam Smith",     email: "liam.smith@example.com",    phone: "0433 999 000", state: "WA",  plan: "starter",    notes: "" },
  { id: 7, name: "Sofia Rossi",    email: "sofia.rossi@example.com",   phone: "0477 123 456", state: "NSW", plan: "pro",        notes: "Referred by Raj Patel." },
  { id: 8, name: "Noah Williams",  email: "noah.williams@example.com", phone: "0488 765 432", state: "SA",  plan: "enterprise", notes: "Requires invoice by PO." },
];

export const salaries = [
  { employee: "Chris Doe (CEO)",       salaryAud: 385000 },
  { employee: "Priya Sharma (CTO)",    salaryAud: 320000 },
  { employee: "Ben Lee (Engineer)",    salaryAud: 145000 },
  { employee: "Emma Brown (Marketing)", salaryAud: 110000 },
];