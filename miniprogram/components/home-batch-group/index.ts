import { componentMethods } from "../../services/component-events";

Component({
  options: { virtualHost: true, styleIsolation: "apply-shared" },
  properties: {
    batchBusy: { type: Boolean, value: false },
    batchFamilyOptions: { type: Array, value: [] },
    pendingCount: { type: Number, value: 0 },
    item: { type: Object, value: null }
  },
  methods: componentMethods(["batchFamilyChange", "batchViewersChange"]),
});
