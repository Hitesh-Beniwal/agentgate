import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// DEV-ONLY keys. In production these would be random and shown once.
const seeds = [
  { team: "marketing", budget: 20, agent: "marketing-assistant", key: "ag_dev_marketing_123" },
  { team: "sales",     budget: 50, agent: "sales-copilot",       key: "ag_dev_sales_456" },
  { team: "hr",        budget: 30, agent: "hr-helper",           key: "ag_dev_hr_789" },
];

for (const s of seeds) {
  const team = await prisma.team.upsert({
    where: { name: s.team },
    update: {},
    create: { name: s.team, budgetAud: s.budget },
  });
  await prisma.agent.upsert({
    where: { keyHash: sha256(s.key) },
    update: {},
    create: { name: s.agent, keyHash: sha256(s.key), teamId: team.id },
  });
  console.log(`✔ ${s.team.padEnd(10)} agent=${s.agent.padEnd(20)} key=${s.key}`);
}

await prisma.$disconnect();