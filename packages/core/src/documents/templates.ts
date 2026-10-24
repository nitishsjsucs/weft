// Document templates for the new-hire portal (w2-onboarding). Every body is generated from DB values, so the
// server can recompute the sha256 a signer saw. The text is original and names the seeded company.
import { formatCents } from "@weft/contracts";
import { sha256Hex } from "../shared/hash";

export interface OfferTemplateInput {
  companyName: string; candidateFirst: string; candidateLast: string; title: string; departmentName: string; managerName: string | null;
  workState: string; baseCents: number; payKind: string; startDate: string; expiresOn: string | null; offerId: string;
}

export function offerLetterText(i: OfferTemplateInput): string {
  const pay = i.payKind === "hourly" ? `${formatCents(i.baseCents)} an hour` : `${formatCents(i.baseCents)} a year, paid semi-monthly`;
  return [
    `${i.companyName}`,
    `Offer letter ${i.offerId}`,
    "",
    `Dear ${i.candidateFirst} ${i.candidateLast},`,
    "",
    `We are delighted to offer you the role of ${i.title} on the ${i.departmentName} team${i.managerName ? `, reporting to ${i.managerName}` : ""}.`,
    `Your first day is ${i.startDate} and your work state is ${i.workState}.`,
    `Your base pay is ${pay}. You are eligible for the company benefit plans from your first day.`,
    `This offer stays open until ${i.expiresOn ?? "your start date"}.`,
    "",
    "Employment is at will. This letter is the whole offer; nothing outside it changes these terms.",
    "",
    "To accept, type your full legal name below and sign.",
  ].join("\n");
}

export function confidentialityText(i: { companyName: string; candidateFirst: string; candidateLast: string; offerId: string }): string {
  return [
    `${i.companyName}`,
    `Confidentiality and invention assignment agreement (offer ${i.offerId})`,
    "",
    `I, ${i.candidateFirst} ${i.candidateLast}, agree to keep the company's non-public information private during and after my employment,`,
    "to use it only to do my job, and to return company property when I leave.",
    "Work I create in the scope of my role belongs to the company. Ideas I developed before I joined stay mine.",
    "",
    "To agree, type your full legal name below and sign.",
  ].join("\n");
}

/** A server-written form record (W-4, state certificate, direct deposit authorization, I-9 section 1, benefits). */
export function formRecordText(title: string, signer: string, lines: [string, string][]): string {
  return [title, "", ...lines.map(([k, v]) => `${k}: ${v}`), "", `Signed electronically by ${signer}.`].join("\n");
}

export const docSha = (bodyText: string): string => sha256Hex(bodyText);
