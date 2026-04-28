import { useGetIdentity, useGetList, useListFilterContext } from "ra-core";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Sale } from "../types";

const ALL = "all";
const MINE = "mine";

export const SalesFilterInput = (_: { alwaysOn: boolean; source: string }) => {
  const { filterValues, displayedFilters, setFilters } = useListFilterContext();
  const { identity } = useGetIdentity();
  const { data: sales } = useGetList<Sale>("sales", {
    pagination: { page: 1, perPage: 100 },
    sort: { field: "first_name", order: "ASC" },
    filter: { "disabled@neq": true },
  });

  const currentValue =
    filterValues.sales_id == null
      ? ALL
      : identity?.id != null && filterValues.sales_id === identity.id
        ? MINE
        : String(filterValues.sales_id);

  const handleChange = (value: string) => {
    const newFilterValues = { ...filterValues };
    if (value === ALL) {
      delete newFilterValues.sales_id;
    } else if (value === MINE) {
      newFilterValues.sales_id = identity?.id;
    } else {
      const numeric = Number(value);
      newFilterValues.sales_id = Number.isNaN(numeric) ? value : numeric;
    }
    setFilters(newFilterValues, displayedFilters);
  };

  return (
    <div className="mt-auto pb-2.25">
      <Select value={currentValue} onValueChange={handleChange}>
        <SelectTrigger className="w-48" aria-label="Propriétaire">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Toutes les opportunités</SelectItem>
          {identity != null && (
            <SelectItem value={MINE}>Mes opportunités</SelectItem>
          )}
          {sales
            ?.filter((sale) => sale.id !== identity?.id)
            .map((sale) => (
              <SelectItem key={sale.id} value={String(sale.id)}>
                {sale.first_name} {sale.last_name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
};
