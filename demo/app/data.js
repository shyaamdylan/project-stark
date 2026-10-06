// Sandbox data for the demo: a fictional machine builder's accounts payable.
// Every company, person and number here is made up.
//
// Two sets, switchable from the user menu:
//   expert   the cases the expert works through while Friday watches
//   trainee  a fresh case the expert never showed, for the new hire's lesson

const COST_CENTERS = [
  { code: '0400', name: 'Capex · Machinery & equipment' },
  { code: '4711', name: 'Opex · Maintenance & repairs' },
  { code: '4720', name: 'Opex · Office & supplies' },
  { code: '4730', name: 'Opex · IT & software' },
  { code: '6100', name: 'Intercompany services' },
];

const APPROVERS = ['Martin Weber · Controller', 'Jana Novák · Finance lead (CZ)', 'Thomas Ruf · Plant manager'];

const SUPPLIERS = {
  hartmann: { name: 'Hartmann Industrietechnik GmbH', city: 'Esslingen', country: 'DE', vat: 'DE 812 334 091', iban: 'DE44 6005 0101 0004 1873 22' },
  brueckner: { name: 'Brückner Bürobedarf KG', city: 'Stuttgart', country: 'DE', vat: 'DE 145 902 778', iban: 'DE18 6004 0071 0525 1190 00' },
  kestrelcz: { name: 'Kestrel Components s.r.o.', city: 'Plzeň', country: 'CZ', vat: 'CZ 2847 1190', iban: 'CZ65 0800 0000 1920 0014 5399', intercompany: true },
  vossberg: { name: 'Vossberg Antriebstechnik GmbH', city: 'Heilbronn', country: 'DE', vat: 'DE 298 551 604', iban: 'DE02 6205 0000 0001 3388 41' },
  lindner: { name: 'Lindner Schmierstoffe GmbH', city: 'Ludwigsburg', country: 'DE', vat: 'DE 271 004 118', iban: 'DE71 6045 0050 0000 2276 18' },
  datalink: { name: 'Datalink IT Services GmbH', city: 'Karlsruhe', country: 'DE', vat: 'DE 318 220 945', iban: 'DE12 6605 0101 0010 4477 30' },
  stahlwerk: { name: 'Stahlhandel Remstal GmbH', city: 'Schorndorf', country: 'DE', vat: 'DE 147 663 205', iban: 'DE90 6025 0010 0015 2210 47' },
  cleanpro: { name: 'CleanPro Gebäudeservice', city: 'Fellbach', country: 'DE', vat: 'DE 266 908 117', iban: 'DE27 6029 1120 0041 7702 05' },
};

// lines: [description, qty, unit price (net)]. VAT 19% unless reverse charge.
const bill = (id, supplier, date, due, lines, extra = {}) => ({ id, supplier, date, due, lines, status: 'review', costCenter: '', assetNo: '', approvers: [APPROVERS[0]], note: '', vatRate: 0.19, ...extra });

const SETS = {
  expert: {
    label: 'Expert walkthrough',
    bills: [
      bill('BILL-2412', 'hartmann', '2026-12-14', '2027-01-13', [['Spindle motor HSK-63F, 24 kW, incl. mounting kit', 1, 11280], ['Installation and commissioning, 1 day', 1, 1200]], { suggested: '4711', received: 'Received by email from invoices@hartmann-it.example · read by OCR' }),
      bill('BILL-2413', 'brueckner', '2026-12-02', '2026-12-30', [['Copier paper A4, 80 g, 50 reams', 1, 189.5], ['Toner cartridges, assorted', 4, 32.25]], { suggested: '4720', received: 'Received by post · scanned' }),
      bill('BILL-2414', 'brueckner', '2026-12-03', '2026-12-31', [['Copier paper A4, 80 g, 50 reams', 1, 189.5], ['Toner cartridges, assorted', 4, 32.25]], { suggested: '4720', received: 'Received by email from rechnung@brueckner.example · read by OCR' }),
      bill('BILL-2415', 'kestrelcz', '2026-12-09', '2027-01-08', [['Machining services, housings batch 46, November', 1, 4950]], { suggested: '6100', vatRate: 0, reverseCharge: true, received: 'Received through the intercompany portal' }),
      bill('BILL-2409', 'lindner', '2026-12-01', '2026-12-31', [['Cutting fluid concentrate, 208 l drum', 2, 486]], { suggested: '4711', status: 'approval', costCenter: '4711' }),
      bill('BILL-2410', 'datalink', '2026-12-05', '2027-01-04', [['Managed backup, December', 1, 640], ['Endpoint licences, 38 seats', 38, 6.9]], { suggested: '4730', status: 'approval', costCenter: '4730' }),
      bill('BILL-2411', 'stahlwerk', '2026-12-08', '2027-01-07', [['Steel bar C45, Ø 60 mm, 6 m', 14, 96.4]], { suggested: '4711', status: 'review' }),
      bill('BILL-2405', 'cleanpro', '2026-11-28', '2026-12-28', [['Facility cleaning, November', 1, 1840]], { suggested: '4711', status: 'approved', costCenter: '4711' }),
    ],
  },
  trainee: {
    label: 'New-hire practice',
    bills: [
      bill('BILL-2431', 'vossberg', '2026-12-16', '2027-01-15', [['Servo drive unit AX-40, 7.5 kW', 1, 6450], ['Encoder cable set, 10 m', 1, 750]], { suggested: '4711', received: 'Received by email from billing@vossberg.example · read by OCR' }),
      bill('BILL-2432', 'lindner', '2026-12-15', '2027-01-14', [['Hydraulic oil HLP 46, 20 l', 6, 74.8]], { suggested: '4711' }),
      bill('BILL-2433', 'datalink', '2026-12-12', '2027-01-11', [['Firewall support, Q1', 1, 420]], { suggested: '4730' }),
      bill('BILL-2428', 'cleanpro', '2026-12-01', '2026-12-31', [['Facility cleaning, December', 1, 1840]], { suggested: '4711', status: 'approval', costCenter: '4711' }),
      bill('BILL-2425', 'stahlwerk', '2026-11-30', '2026-12-30', [['Steel plate S355, 20 mm', 3, 412]], { suggested: '4711', status: 'approved', costCenter: '4711' }),
    ],
  },
};

window.SANDBOX = { COST_CENTERS, APPROVERS, SUPPLIERS, SETS, TODAY: '2026-12-29' };
