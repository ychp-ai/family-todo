import { legalDocuments } from "../../config/legal-documents";
import type { LegalDocument } from "../../config/legal-documents";
import { productInfo } from "../../config/product-info";

Page({
  data: { productInfo, document: null as LegalDocument | null },
  onLoad(query: Record<string, string | undefined>) {
    if (query.type !== "agreement" && query.type !== "privacy") return;
    const document = legalDocuments[query.type];
    this.setData({ document });
    wx.setNavigationBarTitle({ title: document.title });
  },
});
