import { useEffect, useState } from "react";
import { api, type ModelPriceDto } from "../api/client.js";

export default function PriceTablePage() {
  const [prices, setPrices] = useState<ModelPriceDto[]>([]);

  const load = () => api.listPrices().then(setPrices);
  useEffect(() => { load(); }, []);

  const save = async (modelId: string, field: keyof ModelPriceDto, value: number) => {
    const updated = await api.updatePrice(modelId, { [field]: value } as any);
    setPrices((prev) => prev.map((p) => (p.modelId === modelId ? updated : p)));
  };

  return (
    <div>
      <h2>Price table</h2>
      <p style={{ color: "#9aa4b2" }}>Cents per million tokens. Changes apply to new requests only — historical billing is frozen at request time.</p>
      <table>
        <thead>
          <tr>
            <th>Model</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Active</th>
          </tr>
        </thead>
        <tbody>
          {prices.map((p) => (
            <tr key={p.modelId}>
              <td>{p.modelId}</td>
              {(["inputPriceCentsPerMillion", "outputPriceCentsPerMillion", "cacheWritePriceCentsPerMillion", "cacheReadPriceCentsPerMillion"] as const).map((field) => (
                <td key={field}>
                  <input
                    type="number"
                    defaultValue={p[field] as number}
                    onBlur={(e) => save(p.modelId, field, Number(e.target.value))}
                    style={{ width: 90 }}
                  />
                </td>
              ))}
              <td>
                <input type="checkbox" defaultChecked={p.active} onChange={(e) => save(p.modelId, "active", e.target.checked as any)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
