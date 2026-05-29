import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFRef,
} from 'pdf-lib'

export interface OutlineEntry {
  title: string
  /** Zero-based page index in the output PDF that this entry should jump to. */
  pageIndex: number
  children?: OutlineEntry[]
}

interface BuiltItem {
  ref: PDFRef
  dict: PDFDict
  descendantCount: number
}

/**
 * Attaches a PDF outline (bookmarks) tree to the given document.
 * pdf-lib has no first-class outline API, so we hand-build the dicts and
 * wire `/Parent` `/First` `/Last` `/Prev` `/Next` `/Count` `/Dest` per the
 * PDF spec, then attach the outline root to the catalog.
 */
export function addOutline(
  pdf: PDFDocument,
  entries: OutlineEntry[],
): void {
  if (entries.length === 0) return
  const ctx = pdf.context

  // Allocate the outline-root ref up-front so child items can reference it
  // as their /Parent while we're still constructing the tree. We'll fill in
  // the actual dict with ctx.assign() once children are built.
  const rootRef = ctx.nextRef()

  function buildItem(entry: OutlineEntry, parentRef: PDFRef): BuiltItem {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: parentRef,
    })
    const ref = ctx.register(dict)

    // Destination: [<pageRef> /Fit] — show the whole page on jump.
    const page = pdf.getPage(entry.pageIndex)
    const dest = PDFArray.withContext(ctx)
    dest.push(page.ref)
    dest.push(PDFName.of('Fit'))
    dict.set(PDFName.of('Dest'), dest)

    const childItems = (entry.children ?? []).map((c) => buildItem(c, ref))
    if (childItems.length > 0) {
      dict.set(PDFName.of('First'), childItems[0].ref)
      dict.set(PDFName.of('Last'), childItems[childItems.length - 1].ref)
      const descendantTotal = childItems.reduce(
        (acc, ci) => acc + 1 + ci.descendantCount,
        0,
      )
      // Positive /Count → tree node starts expanded in the bookmarks panel.
      dict.set(PDFName.of('Count'), PDFNumber.of(descendantTotal))

      for (let i = 0; i < childItems.length; i++) {
        if (i > 0)
          childItems[i].dict.set(PDFName.of('Prev'), childItems[i - 1].ref)
        if (i < childItems.length - 1)
          childItems[i].dict.set(PDFName.of('Next'), childItems[i + 1].ref)
      }
      return { ref, dict, descendantCount: descendantTotal }
    }
    return { ref, dict, descendantCount: 0 }
  }

  const topItems = entries.map((e) => buildItem(e, rootRef))
  for (let i = 0; i < topItems.length; i++) {
    if (i > 0) topItems[i].dict.set(PDFName.of('Prev'), topItems[i - 1].ref)
    if (i < topItems.length - 1)
      topItems[i].dict.set(PDFName.of('Next'), topItems[i + 1].ref)
  }

  const rootDescendantCount = topItems.reduce(
    (acc, ti) => acc + 1 + ti.descendantCount,
    0,
  )
  const rootDict = ctx.obj({
    Type: PDFName.of('Outlines'),
    First: topItems[0].ref,
    Last: topItems[topItems.length - 1].ref,
    Count: PDFNumber.of(rootDescendantCount),
  })
  ctx.assign(rootRef, rootDict)

  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}
