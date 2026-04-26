import { useGetList } from "ra-core";
import { CheckSquare } from "lucide-react";

import { Task } from "../tasks/Task";
import type { Task as TTask } from "../types";

export const DealTasks = ({ contactIds }: { contactIds?: number[] }) => {
  const hasContacts = !!contactIds?.length;
  const { data: tasks, isPending } = useGetList<TTask>(
    "tasks",
    {
      pagination: { page: 1, perPage: 50 },
      sort: { field: "due_date", order: "ASC" },
      filter: {
        "contact_id@in": `(${contactIds?.join(",")})`,
        "done_date@is": null,
      },
    },
    { enabled: hasContacts },
  );

  if (!hasContacts || isPending || !tasks?.length) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center text-xs text-muted-foreground tracking-wide">
        <CheckSquare className="w-3.5 h-3.5 mr-1.5" />
        <span>Tâches programmées</span>
      </div>
      <div className="space-y-2">
        {tasks.map((task) => (
          <Task key={task.id} task={task} showContact showTime={false} />
        ))}
      </div>
    </div>
  );
};
