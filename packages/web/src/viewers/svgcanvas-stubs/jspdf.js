// svgcanvas imports jsPDF for its own PDF export, which the drawing editor never uses (G37.6):
// «Esporta come PDF» is made on the server. This stands in for it, so jsPDF is not carried.
export class jsPDF {
  constructor() {
    throw new Error("PDF export is not part of the drawing editor");
  }
}
export default { jsPDF };
