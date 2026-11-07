// A realistic IDML for the layout tests (G34.3, «IDML perde l'impaginazione non va bene»): three
// A4 pages on two spreads (the second one facing), a master spread with a page number and a rule,
// two layers, colours (CMYK, RGB, a tint), paragraph and character styles based on each other,
// a title, a text that flows through two linked frames, a rotated rectangle, an oval, a line, a
// triangle with a curve, a group, a linked image (cropped by its frame), an embedded image, and
// an item left on the pasteboard. `IDML_EXPECTED` says where everything is on its page, in points,
// worked out by hand from the transforms below.

import { encode as encodePng } from "fast-png";
import { strToU8, zipSync } from "fflate";

export const A4 = { w: 595.276, h: 841.89 };
const HALF = A4.h / 2; // the spreads' origin is at the middle of their height

const png = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return encodePng({ width: w, height: h, data, channels: 4, depth: 8 });
};

/** The linked image the IDML points to (Links/beach.png beside it): 400 × 300 px, no DPI (72 pt). */
export const beachPng = () => png(400, 300, [230, 200, 120]);
const embeddedPng = () => png(20, 10, [10, 120, 200]);

const rectPath = (w: number, h: number, x0 = -w / 2, y0 = -h / 2) =>
  pathOf([
    [x0, y0],
    [x0, y0 + h],
    [x0 + w, y0 + h],
    [x0 + w, y0],
  ]);

function pathOf(points: number[][], open = false, curves: Record<number, number[]> = {}) {
  const pts = points
    .map(([x, y], i) => {
      const c = curves[i];
      const a = `${x} ${y}`;
      const l = c ? `${c[0]} ${c[1]}` : a;
      const r = c ? `${c[2]} ${c[3]}` : a;
      return `<PathPointType Anchor="${a}" LeftDirection="${l}" RightDirection="${r}"/>`;
    })
    .join("");
  return `<Properties><PathGeometry><GeometryPathType PathOpen="${open}"><PathPointArray>${pts}</PathPointArray></GeometryPathType></PathGeometry></Properties>`;
}

const PKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="16.0"';
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Where each item lands on its page (points, top left of its box before rotation). */
export const IDML_EXPECTED = {
  pages: 3,
  title: { page: 0, x: 56.693, y: 70.945, w: 481.89, h: 100 },
  rotated: { page: 0, x: 300, y: 400, w: 120, h: 60, angle: 30 },
  image: { page: 0, x: 60, y: 450, w: 200, h: 150 },
  body1: { page: 1, x: 56.693, y: 56.693, w: 230, h: 300 },
  body2: { page: 2, x: 56.693, y: 56.693, w: 230, h: 300 },
  oval: { page: 2, x: 350, y: 500, w: 150, h: 100 },
  groupA: { page: 2, x: 100, y: 650, w: 50, h: 50 },
  groupB: { page: 2, x: 170, y: 650, w: 50, h: 50 },
  embedded: { page: 1, x: 300, y: 600, w: 100, h: 50 },
};

const LONG =
  "Layout matters. This paragraph is long enough to need two frames: it starts in the first column and goes on in the second one, the way InDesign threads a story through linked frames. ".repeat(
    8,
  );

export function idmlSample(): Uint8Array {
  const design = `${head}<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="16.0(32)" ?>
<Document ${PKG} Self="d" StoryList="u10 u20 u30" ActiveLayer="ulText">
<Language Self="Language/$ID/English%3a USA" Name="$ID/English: USA"/>
<idPkg:Graphic src="Resources/Graphic.xml"/>
<idPkg:Fonts src="Resources/Fonts.xml"/>
<idPkg:Styles src="Resources/Styles.xml"/>
<idPkg:Preferences src="Resources/Preferences.xml"/>
<Layer Self="ulBack" Name="Background" Visible="true" Locked="false" Printable="true"/>
<Layer Self="ulText" Name="Text" Visible="true" Locked="false" Printable="true"/>
<idPkg:MasterSpread src="MasterSpreads/MasterSpread_uA.xml"/>
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Spread src="Spreads/Spread_s2.xml"/>
<idPkg:BackingStory src="XML/BackingStory.xml"/>
<idPkg:Story src="Stories/Story_u10.xml"/>
<idPkg:Story src="Stories/Story_u20.xml"/>
<idPkg:Story src="Stories/Story_u30.xml"/>
</Document>`;
  const graphic = `${head}<idPkg:Graphic ${PKG}>
<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
<Color Self="Color/Paper" Model="Process" Space="CMYK" ColorValue="0 0 0 0" Name="Paper"/>
<Color Self="Color/Red" Model="Process" Space="CMYK" ColorValue="0 100 100 0" Name="Red"/>
<Color Self="Color/Ocean" Model="Process" Space="RGB" ColorValue="0 105 148" Name="Ocean"/>
<Tint Self="Tint/Ocean 50" BaseColor="Color/Ocean" TintValue="50" Name="$ID/"/>
<Swatch Self="Swatch/None" Name="None"/>
</idPkg:Graphic>`;
  const fonts = `${head}<idPkg:Fonts ${PKG}><FontFamily Self="di1" Name="Minion Pro"><Font Self="di1Regular" FontFamily="Minion Pro" Name="Minion Pro Regular" FontStyleName="Regular"/></FontFamily></idPkg:Fonts>`;
  const styles = `${head}<idPkg:Styles ${PKG}>
<RootCharacterStyleGroup Self="rcs">
<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>
<CharacterStyle Self="CharacterStyle/Emphasis" Name="Emphasis" FontStyle="Italic" FillColor="Color/Red"/>
</RootCharacterStyleGroup>
<RootParagraphStyleGroup Self="rps">
<ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle" PointSize="12" FillColor="Color/Black"><Properties><AppliedFont type="string">Minion Pro</AppliedFont><Leading type="enumeration">Auto</Leading></Properties></ParagraphStyle>
<ParagraphStyle Self="ParagraphStyle/Heading 1" Name="Heading 1" PointSize="28" FontStyle="Bold" FillColor="Color/Ocean" SpaceAfter="6"><Properties><BasedOn type="string">ParagraphStyle/$ID/NormalParagraphStyle</BasedOn></Properties></ParagraphStyle>
<ParagraphStyle Self="ParagraphStyle/Body" Name="Body" PointSize="10" Justification="LeftJustified" FirstLineIndent="12"><Properties><BasedOn type="string">ParagraphStyle/$ID/NormalParagraphStyle</BasedOn><Leading type="unit">14</Leading></Properties></ParagraphStyle>
<ParagraphStyle Self="ParagraphStyle/Folio" Name="Folio" PointSize="9" Justification="CenterAlign"><Properties><BasedOn type="string">ParagraphStyle/Body</BasedOn></Properties></ParagraphStyle>
</RootParagraphStyleGroup>
</idPkg:Styles>`;
  const prefs = `${head}<idPkg:Preferences ${PKG}><DocumentPreference PageHeight="${A4.h}" PageWidth="${A4.w}" PagesPerDocument="3" FacingPages="true" DocumentBleedTopOffset="0" DocumentBleedBottomOffset="0" DocumentBleedInsideOrLeftOffset="0" DocumentBleedOutsideOrRightOffset="0"/><MarginPreference Top="56.693" Bottom="56.693" Left="56.693" Right="56.693" ColumnCount="1" ColumnGutter="12"/></idPkg:Preferences>`;
  const page = (self: string, name: string, tx: number, master = "uA") =>
    `<Page Self="${self}" Name="${name}" AppliedMaster="${master}" GeometricBounds="0 0 ${A4.h} ${A4.w}" ItemTransform="1 0 0 1 ${tx} ${-HALF}" MasterPageTransform="1 0 0 1 0 0"><MarginPreference Top="56.693" Bottom="56.693" Left="56.693" Right="56.693" ColumnCount="1"/></Page>`;
  // The master: a folio (the page number) and a rule at the foot of each of its two pages.
  const masterSide = (side: "l" | "r", tx: number) =>
    `<TextFrame Self="uAf${side}" ParentStory="u30" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" ItemLayer="ulText" ItemTransform="1 0 0 1 ${tx + A4.w / 2} ${HALF - 30}">${rectPath(100, 20)}<TextFramePreference TextColumnCount="1" VerticalJustification="CenterAlign"/></TextFrame>` +
    `<GraphicLine Self="uAr${side}" ItemLayer="ulBack" StrokeColor="Color/Black" StrokeWeight="0.5" FillColor="Swatch/None" ItemTransform="1 0 0 1 ${tx} 0">${pathOf(
      [
        [56.693, HALF - 45],
        [A4.w - 56.693, HALF - 45],
      ],
      true,
    )}</GraphicLine>`;
  const master = `${head}<idPkg:MasterSpread ${PKG}><MasterSpread Self="uA" Name="A-Master" NamePrefix="A" BaseName="Master" PageCount="2" ItemTransform="1 0 0 1 0 0">
${page("uAp1", "A", -A4.w, "n")}${page("uAp2", "A", 0, "n")}
${masterSide("l", -A4.w)}${masterSide("r", 0)}
</MasterSpread></idPkg:MasterSpread>`;
  // Spread 1: page 1 alone, at x 0..A4.w in the spread.
  const spread1 = `${head}<idPkg:Spread ${PKG}><Spread Self="s1" PageCount="1" BindingLocation="0" ItemTransform="1 0 0 1 0 0">
${page("p1", "1", 0)}
<TextFrame Self="tfTitle" ParentStory="u10" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" ItemLayer="ulText" FillColor="Tint/Ocean 50" StrokeColor="Swatch/None" ItemTransform="1 0 0 1 297.638 ${-300 - 0}">${rectPath(481.89, 100)}<TextFramePreference TextColumnCount="1" VerticalJustification="TopAlign"><Properties><InsetSpacing type="list"><ListItem type="unit">6</ListItem><ListItem type="unit">8</ListItem><ListItem type="unit">6</ListItem><ListItem type="unit">8</ListItem></InsetSpacing></Properties></TextFramePreference></TextFrame>
<Rectangle Self="rRot" ContentType="Unassigned" ItemLayer="ulBack" FillColor="Color/Red" StrokeColor="Color/Black" StrokeWeight="2" ItemTransform="${Math.cos(Math.PI / 6)} ${-Math.sin(Math.PI / 6)} ${Math.sin(Math.PI / 6)} ${Math.cos(Math.PI / 6)} 300 ${400 - HALF}">${rectPath(120, 60, 0, 0)}<TransparencySetting><BlendingSetting Opacity="80"/><DropShadowSetting Mode="Drop" Distance="5"/></TransparencySetting></Rectangle>
<Rectangle Self="rImg" ContentType="GraphicType" ItemLayer="ulBack" FillColor="Swatch/None" StrokeColor="Swatch/None" ItemTransform="1 0 0 1 60 ${450 - HALF}">${rectPath(200, 150, 0, 0)}<Image Self="img1" ItemTransform="0.6 0 0 0.6 -20 -10"><Properties><Profile type="string">$ID/Embedded</Profile><GraphicBounds Left="0" Top="0" Right="400" Bottom="300"/></Properties><Link Self="lk1" LinkResourceURI="file:/Users/designer/Jobs/Spring/Links/beach.png" StoredState="Normal"/></Image></Rectangle>
<Oval Self="ovPaste" ItemLayer="ulBack" FillColor="Color/Red" ItemTransform="1 0 0 1 900 0">${rectPath(40, 40)}</Oval>
</Spread></idPkg:Spread>`;
  // Spread 2: pages 2 (left, x -A4.w..0) and 3 (right, 0..A4.w).
  const triangle = pathOf(
    [
      [0, 80],
      [60, 0],
      [120, 80],
    ],
    false,
    { 1: [30, -20, 90, -20] },
  );
  // A circle of radius 50 as InDesign draws it: four anchors with their handles (kappa).
  const k = 50 * 0.5523;
  const circle = pathOf(
    [
      [0, -50],
      [-50, 0],
      [0, 50],
      [50, 0],
    ],
    false,
    { 0: [k, -50, -k, -50], 1: [-50, -k, -50, k], 2: [-k, 50, k, 50], 3: [50, k, 50, -k] },
  );
  const spread2 = `${head}<idPkg:Spread ${PKG}><Spread Self="s2" PageCount="2" BindingLocation="1" ItemTransform="1 0 0 1 0 0">
${page("p2", "2", -A4.w)}${page("p3", "3", 0)}
<TextFrame Self="tfBody1" ParentStory="u20" PreviousTextFrame="n" NextTextFrame="tfBody2" ContentType="TextType" ItemLayer="ulText" ItemTransform="1 0 0 1 ${-A4.w + 56.693} ${56.693 - HALF}">${rectPath(230, 300, 0, 0)}<TextFramePreference TextColumnCount="1"/></TextFrame>
<TextFrame Self="tfBody2" ParentStory="u20" PreviousTextFrame="tfBody1" NextTextFrame="n" ContentType="TextType" ItemLayer="ulText" ItemTransform="1 0 0 1 56.693 ${56.693 - HALF}">${rectPath(230, 300, 0, 0)}<TextFramePreference TextColumnCount="1"/></TextFrame>
<GraphicLine Self="gl1" ItemLayer="ulBack" StrokeColor="Color/Ocean" StrokeWeight="3" FillColor="Swatch/None" ItemTransform="1 0 0 1 ${-A4.w} ${-HALF}">${pathOf(
    [
      [56.693, 420],
      [300, 520],
    ],
    true,
  )}</GraphicLine>
<Rectangle Self="rEmb" ContentType="GraphicType" ItemLayer="ulBack" StrokeColor="Swatch/None" FillColor="Swatch/None" ItemTransform="1 0 0 1 ${-A4.w + 300} ${600 - HALF}">${rectPath(100, 50, 0, 0)}<Image Self="img2" ItemTransform="5 0 0 5 0 0"><Properties><Contents><![CDATA[${Buffer.from(embeddedPng()).toString("base64")}]]></Contents><GraphicBounds Left="0" Top="0" Right="20" Bottom="10"/></Properties></Image></Rectangle>
<Oval Self="ov1" ItemLayer="ulBack" FillColor="Swatch/None" StrokeColor="Color/Red" StrokeWeight="4" ItemTransform="1.5 0 0 1 425 ${550 - HALF}">${circle}</Oval>
<Polygon Self="pg1" ItemLayer="ulBack" FillColor="Color/Ocean" StrokeColor="Swatch/None" ItemTransform="1 0 0 1 400 ${100 - HALF}">${triangle}</Polygon>
<Group Self="g1" ItemLayer="ulBack" ItemTransform="1 0 0 1 100 ${650 - HALF}">
<Rectangle Self="gA" ItemLayer="ulBack" FillColor="Color/Red" StrokeColor="Swatch/None" ItemTransform="1 0 0 1 0 0">${rectPath(50, 50, 0, 0)}</Rectangle>
<Rectangle Self="gB" ItemLayer="ulBack" FillColor="Color/Ocean" StrokeColor="Swatch/None" ItemTransform="1 0 0 1 70 0">${rectPath(50, 50, 0, 0)}</Rectangle>
</Group>
</Spread></idPkg:Spread>`;
  const story = (self: string, body: string) =>
    `${head}<idPkg:Story ${PKG}><Story Self="${self}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n"><StoryPreference OpticalMarginAlignment="false"/>${body}</Story></idPkg:Story>`;
  const plain = 'AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"';
  const title = story(
    "u10",
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Heading 1"><CharacterStyleRange ${plain}><Content>Spring &amp; Summer</Content><Br/></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body" Justification="CenterAlign"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Emphasis" FontStyle="Bold" PointSize="11"><Content>New colours</Content></CharacterStyleRange><CharacterStyleRange ${plain}><Content> for everyone.</Content></CharacterStyleRange></ParagraphStyleRange>`,
  );
  const body = story(
    "u20",
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange ${plain}><Content>${LONG}</Content><Br/><Content>The end of the story, in the second frame.</Content></CharacterStyleRange></ParagraphStyleRange>`,
  );
  const folio = story(
    "u30",
    `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Folio"><CharacterStyleRange ${plain}><Content>Page <?ACE 18?></Content></CharacterStyleRange></ParagraphStyleRange>`,
  );
  return zipSync({
    mimetype: [strToU8("application/vnd.adobe.indesign-idml-package"), { level: 0 }],
    "designmap.xml": strToU8(design),
    "META-INF/container.xml": strToU8(
      `${head}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`,
    ),
    "Resources/Graphic.xml": strToU8(graphic),
    "Resources/Fonts.xml": strToU8(fonts),
    "Resources/Styles.xml": strToU8(styles),
    "Resources/Preferences.xml": strToU8(prefs),
    "MasterSpreads/MasterSpread_uA.xml": strToU8(master),
    "Spreads/Spread_s1.xml": strToU8(spread1),
    "Spreads/Spread_s2.xml": strToU8(spread2),
    "XML/BackingStory.xml": strToU8(
      `${head}<idPkg:BackingStory ${PKG}><XmlStory Self="ubs" AppliedTOCStyle="n"/></idPkg:BackingStory>`,
    ),
    "Stories/Story_u10.xml": strToU8(title),
    "Stories/Story_u20.xml": strToU8(body),
    "Stories/Story_u30.xml": strToU8(folio),
  });
}
