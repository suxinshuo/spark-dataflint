import { Edge, Graph } from "graphlib";
import { v4 as uuidv4 } from "uuid";
import {
  EnrichedSparkSQL,
  EnrichedSqlEdge,
  EnrichedSqlMetric,
  EnrichedSqlNode,
  ExchangeMetrics,
  ParsedNodePlan,
  SparkSQLStore,
  SparkStagesStore,
} from "../interfaces/AppStore";
import { RddStorageInfo } from "../interfaces/CachedStorage";
import { IcebergCommitsInfo, IcebergInfo } from "../interfaces/IcebergInfo";
import { SQLNodePlan, SQLPlan, SQLPlans } from "../interfaces/SQLPlan";
import { SparkSQL, SparkSQLs, SqlStatus } from "../interfaces/SparkSQLs";
import { NodesMetrics } from "../interfaces/SqlMetrics";
import {
  calculatePercentage,
  timeStrToEpocTime,
  timeStringToMilliseconds,
} from "../utils/FormatUtils";
import { findLastNodeWithInputRows, generateGraph, getRowsFromMetrics } from "./PlanGraphUtils";
import { parseCoalesce } from "./PlanParsers/CoalesceParser";
import { parseCollectLimit } from "./PlanParsers/CollectLimitParser";
import { parseExchange } from "./PlanParsers/ExchangeParser";
import { parseFilter } from "./PlanParsers/FilterParser";
import { parseJoin } from "./PlanParsers/JoinParser";
import { parseProject } from "./PlanParsers/ProjectParser";
import { parseFileScan } from "./PlanParsers/ScanFileParser";
import { parseSort } from "./PlanParsers/SortParser";
import { parseTakeOrderedAndProject } from "./PlanParsers/TakeOrderedAndProjectParser";
import { parseWindow } from "./PlanParsers/WindowParser";
import { parseWriteToHDFS } from "./PlanParsers/WriteToHDFSParser";
import { parseHashAggregate } from "./PlanParsers/hashAggregateParser";
import {
  calcNodeMetrics,
  calcNodeType,
  extractTotalFromStatisticsMetric,
  nodeEnrichedNameBuilder,
} from "./SqlReducerUtils";

export function cleanUpDAG(
  edges: EnrichedSqlEdge[],
  allNodes: EnrichedSqlNode[],
  visibleNodes: EnrichedSqlNode[],
): EnrichedSqlEdge[] {
  var g = generateGraph(edges, allNodes);

  const visibleNodesIds = visibleNodes.map((node) => node.nodeId);
  const notVisibleNodes = allNodes.filter(
    (node) => !visibleNodesIds.includes(node.nodeId),
  );

  notVisibleNodes.forEach((node) => {
    const nodeId = node.nodeId.toString();
    const inEdges = g.inEdges(nodeId) as Edge[];
    if (inEdges === undefined) {
      return;
    }
    const targets = g.outEdges(nodeId) as Edge[];
    if (targets === undefined || targets.length === 0) {
      return;
    }
    const target = targets[0];
    inEdges.forEach((inEdge) => g.setEdge(inEdge.v, target.w));
    g.removeNode(nodeId);
  });

  const filteredEdges: EnrichedSqlEdge[] = g.edges().map((edge: Edge) => {
    return { fromId: parseInt(edge.v), toId: parseInt(edge.w) };
  });

  const removeRedundentEdges = filteredEdges.filter(
    (edge) =>
      visibleNodesIds.includes(edge.toId) &&
      visibleNodesIds.includes(edge.fromId),
  );

  return removeRedundentEdges;
}

export function parseNodePlan(
  node: EnrichedSqlNode,
  plan: SQLNodePlan,
): ParsedNodePlan | undefined {
  try {
    switch (node.nodeName) {
      case "PhotonGroupingAgg":
      case "GpuHashAggregate":
      case "!CometGpuHashAggregate":
      case "HashAggregate":
        return {
          type: "HashAggregate",
          plan: parseHashAggregate(plan.planDescription),
        };

      case "TakeOrderedAndProject":
        return {
          type: "TakeOrderedAndProject",
          plan: parseTakeOrderedAndProject(plan.planDescription),
        };
      case "CollectLimit":
        return {
          type: "CollectLimit",
          plan: parseCollectLimit(plan.planDescription),
        };
      case "Coalesce":
        return {
          type: "Coalesce",
          plan: parseCoalesce(plan.planDescription),
        };
      case "Execute InsertIntoHadoopFsRelationCommand":
        return {
          type: "WriteToHDFS",
          plan: parseWriteToHDFS(plan.planDescription),
        };
      case "PhotonFilter":
      case "GpuFilter":
      case "CometFilter":
      case "Filter":
        return {
          type: "Filter",
          plan: parseFilter(plan.planDescription),
        };
      case "Exchange":
      case "CometExchange":
      case "CometColumnarExchange":
      case "GpuColumnarExchange":
        return {
          type: "Exchange",
          plan: parseExchange(plan.planDescription),
        };
      case "PhotonProject":
      case "GpuProject":
      case "CometFilter":
      case "Project":
        return {
          type: "Project",
          plan: parseProject(plan.planDescription),
        };
      case "GpuSort":
      case "CometSort":
      case "Sort":
        return {
          type: "Sort",
          plan: parseSort(plan.planDescription),
        };
      case "Window":
        return {
          type: "Window",
          plan: parseWindow(plan.planDescription),
        };
    }
    if (node.nodeName.includes("Scan")) {
      return {
        type: "FileScan",
        plan: parseFileScan(plan.planDescription, node.nodeName),
      };
    }
    if (node.nodeName.includes("Join")) {
      return {
        type: "Join",
        plan: parseJoin(plan.planDescription),
      };
    }
  } catch (e) {
    console.log(`failed to parse plan for node type: ${node.nodeName}`, e);
  }
  return undefined;
}

export function getMetricDuration(
  metricName: string,
  metrics: EnrichedSqlMetric[],
): number | undefined {
  const durationStr = metrics.find((metric) => metric.name === metricName)
    ?.value;
  if (durationStr === undefined) {
    return undefined;
  }
  const totalDurationStr = extractTotalFromStatisticsMetric(durationStr);
  const duration = timeStringToMilliseconds(totalDurationStr);
  return duration;
}

function calculateSql(
  sql: SparkSQL,
  plan: SQLPlan | undefined,
  icebergCommit: IcebergCommitsInfo | undefined,
  stages: SparkStagesStore,
): EnrichedSparkSQL {
  const enrichedSql = sql as EnrichedSparkSQL;
  const originalNumOfNodes = enrichedSql.nodes.length;
  const typeEnrichedNodes = enrichedSql.nodes.map((node) => {
    const type = calcNodeType(node.nodeName);
    const nodePlan = plan?.nodesPlan.find(
      (planNode) => planNode.id === node.nodeId,
    );
    const parsedPlan =
      nodePlan !== undefined ? parseNodePlan(node, nodePlan) : undefined;
    const isCodegenNode = node.nodeName.includes("WholeStageCodegen");

    return {
      ...node,
      rddScopeId: nodePlan?.rddScopeId,
      type: type,
      parsedPlan: parsedPlan,
      enrichedName: nodeEnrichedNameBuilder(node.nodeName, parsedPlan),
      isCodegenNode: isCodegenNode,
      wholeStageCodegenId: isCodegenNode
        ? extractCodegenId()
        : node.wholeStageCodegenId,
      icebergCommit:
        type === "output" || enrichedSql.nodes.length === 1
          ? icebergCommit
          : undefined,
    };

    function extractCodegenId(): number | undefined {
      return parseInt(
        node.nodeName.replace("WholeStageCodegen (", "").replace(")", ""),
      );
    }
  });

  const onlyCodeGenNodes = typeEnrichedNodes
    .filter((node) => node.isCodegenNode)
    .map((node) => {
      const codegenDuration = calcCodegenDuration(node.metrics);
      return { ...node, codegenDuration: codegenDuration };
    });

  const onlyGraphNodes = typeEnrichedNodes.filter(
    (node) => !node.isCodegenNode,
  );

  if (onlyGraphNodes.filter((node) => node.type === "output").length === 0) {
    const aqeFilteredNodes = onlyGraphNodes.filter(
      (node) =>
        node.nodeName !== "AdaptiveSparkPlan" &&
        node.nodeName !== "ResultQueryStage",
    );
    const lastNode = aqeFilteredNodes[aqeFilteredNodes.length - 1];
    lastNode.type = "output";
  }

  const metricEnrichedNodes: EnrichedSqlNode[] = onlyGraphNodes.map((node) => {
    const exchangeMetrics = calcExchangeMetrics(node.nodeName, node.metrics);
    const exchangeBroadcastDuration = calcBroadcastExchangeDuration(
      node.nodeName,
      node.metrics,
    );
    const graph = generateGraph(enrichedSql.edges, enrichedSql.nodes);
    return {
      ...node,
      metrics: updateNodeMetrics(node, node.metrics, graph, onlyGraphNodes),
      exchangeMetrics: exchangeMetrics,
      exchangeBroadcastDuration: exchangeBroadcastDuration,
    };
  });

  const ioNodes = onlyGraphNodes.filter(
    (node) =>
      node.type === "input" || node.type === "output" || node.type === "join",
  );
  const basicNodes = onlyGraphNodes.filter(
    (node) =>
      node.type === "input" ||
      node.type === "output" ||
      node.type === "join" ||
      node.type === "transformation",
  );
  const advancedNodes = onlyGraphNodes.filter((node) => node.type !== "other");
  const ioNodesIds = ioNodes.map((node) => node.nodeId);
  const basicNodesIds = basicNodes.map((node) => node.nodeId);
  const advancedNodesIds = advancedNodes.map((node) => node.nodeId);

  const basicFilteredEdges = cleanUpDAG(
    enrichedSql.edges,
    onlyGraphNodes,
    basicNodes,
  );

  const advancedFilteredEdges = cleanUpDAG(
    enrichedSql.edges,
    onlyGraphNodes,
    advancedNodes,
  );

  const ioFilteredEdges = cleanUpDAG(
    enrichedSql.edges,
    onlyGraphNodes,
    ioNodes,
  );

  const isSqlCommand =
    sql.runningJobIds.length === 0 &&
    sql.failedJobIds.length === 0 &&
    sql.successJobIds.length === 0;

  return {
    ...enrichedSql,
    nodes: metricEnrichedNodes,
    codegenNodes: onlyCodeGenNodes,
    filters: {
      io: {
        nodesIds: ioNodesIds,
        edges: ioFilteredEdges,
      },
      basic: {
        nodesIds: basicNodesIds,
        edges: basicFilteredEdges,
      },
      advanced: {
        nodesIds: advancedNodesIds,
        edges: advancedFilteredEdges,
      },
    },
    uniqueId: uuidv4(),
    metricUpdateId: uuidv4(),
    isSqlCommand: isSqlCommand,
    originalNumOfNodes: originalNumOfNodes,
    submissionTimeEpoc: timeStrToEpocTime(sql.submissionTime),
  };
}

function calculateSqls(
  sqls: SparkSQLs,
  plans: SQLPlans,
  icebergInfo: IcebergInfo,
  stages: SparkStagesStore,
): EnrichedSparkSQL[] {
  return sqls.map((sql) => {
    const plan = plans.find((plan) => plan.executionId === parseInt(sql.id));
    const icebergCommit = icebergInfo.commitsInfo.find(
      (plan) => plan.executionId === parseInt(sql.id),
    );
    return calculateSql(sql, plan, icebergCommit, stages);
  });
}

export function calculateSqlStore(
  currentStore: SparkSQLStore | undefined,
  sqls: SparkSQLs,
  plans: SQLPlans,
  icebergInfo: IcebergInfo,
  stages: SparkStagesStore,
): SparkSQLStore {
  if (currentStore === undefined) {
    return { sqls: calculateSqls(sqls, plans, icebergInfo, stages) };
  }

  const sqlIds = sqls.map((sql) => parseInt(sql.id));
  const minId = Math.min(...sqlIds);

  // add existing completed IDs
  let updatedSqls: EnrichedSparkSQL[] = currentStore.sqls.filter(
    (sql) => parseInt(sql.id) < minId,
  );

  for (const id of sqlIds) {
    const newSql = sqls.find(
      (existingSql) => parseInt(existingSql.id) === id,
    ) as SparkSQL;
    const currentSql = currentStore.sqls.find(
      (existingSql) => parseInt(existingSql.id) === id,
    );
    const plan = plans.find((plan) => plan.executionId === id);
    const icebergCommit = icebergInfo.commitsInfo.find(
      (plan) => plan.executionId === id,
    );

    // case 1: SQL does not exist, we add it
    if (currentSql === undefined) {
      updatedSqls.push(calculateSql(newSql, plan, icebergCommit, stages));
      // From here currentSql must not be null
      // case 2: plan status changed from running to completed, so we need to update the SQL
    } else if (
      newSql.status === SqlStatus.Completed.valueOf() ||
      newSql.status === SqlStatus.Failed.valueOf()
    ) {
      updatedSqls.push(calculateSql(newSql, plan, icebergCommit, stages));
      // From here newSql.status must be RUNNING
      // case 3: running SQL structure, so we need to update the plan
    } else if (currentSql.originalNumOfNodes !== newSql.nodes.length) {
      updatedSqls.push(calculateSql(newSql, plan, icebergCommit, stages));
    } else {
      // case 4: SQL is running, but the structure haven't changed, so we update only relevant fields
      updatedSqls.push({
        ...currentSql,
        duration: newSql.duration,
        failedJobIds: newSql.failedJobIds,
        runningJobIds: newSql.runningJobIds,
        successJobIds: newSql.successJobIds,
      });
    }
  }

  return { sqls: updatedSqls };
}

export function updateSqlNodeMetrics(
  currentStore: SparkSQLStore,
  sqlId: string,
  sqlMetrics: NodesMetrics,
  stages: SparkStagesStore,
): SparkSQLStore {
  const runningSqls = currentStore.sqls.filter((sql) => sql.id === sqlId);
  if (runningSqls.length === 0) {
    // Shouldn't happen as if we ask for updated SQL metric we should have the SQL in store
    return currentStore;
  }

  const runningSql = runningSqls[0];
  const nodes = runningSql.nodes.map((node) => {
    const matchedMetricsNodes = sqlMetrics.filter(
      (nodeMetrics) => nodeMetrics.id === node.nodeId,
    );
    if (matchedMetricsNodes.length === 0) {
      return node;
    }

    // TODO: cache the graph
    const graph = generateGraph(runningSql.edges, runningSql.nodes);
    const metrics = updateNodeMetrics(node, matchedMetricsNodes[0].metrics, graph, runningSql.nodes);
    const exchangeMetrics = calcExchangeMetrics(node.nodeName, metrics);

    // TODO: maybe do a smarter replacement, or send only the initialized metrics
    return {
      ...node,
      metrics: metrics,
      exchangeMetrics: exchangeMetrics,
    };
  });

  const codegenNodes = runningSql.codegenNodes.map((node) => {
    const matchedMetricsNodes = sqlMetrics.filter(
      (nodeMetrics) => nodeMetrics.id === node.nodeId,
    );
    if (matchedMetricsNodes.length === 0) {
      return node;
    }

    const metrics = calcNodeMetrics(node.type, matchedMetricsNodes[0].metrics);
    const codegenDuration = calcCodegenDuration(metrics);

    return {
      ...node,
      codegenDuration: codegenDuration,
    };
  });
  const nodesWithStorageInfo = calculateNodeToStorageInfo(stages, nodes);
  const nodesEnrichedWithStorageInfo = nodes.map(node => {
    const storageInfo = nodesWithStorageInfo.find((nodeWithStorage) => nodeWithStorage.nodeId === node.nodeId)?.storageInfo;
    return storageInfo === undefined ? node : {
      ...node,
      storageInfo: storageInfo,
    };
  })

  const updatedSql = {
    ...runningSql,
    nodes: nodesEnrichedWithStorageInfo,
    codegenNodes: codegenNodes,
    metricUpdateId: uuidv4(),
  };
  const notEffectedSqlsBefore = currentStore.sqls.filter(
    (sql) => sql.id < sqlId,
  );
  const notEffectedSqlsAfter = currentStore.sqls.filter(
    (sql) => sql.id > sqlId,
  );
  return {
    ...currentStore,
    sqls: [...notEffectedSqlsBefore, updatedSql, ...notEffectedSqlsAfter],
  };
}
interface NodeStorageInfo {
  nodeId: number;
  storageInfo: RddStorageInfo | undefined;
}

export function calculateNodeToStorageInfo(stages: SparkStagesStore, nodes: EnrichedSqlNode[]): NodeStorageInfo[] {
  const stagesWithCachesStorage = stages.filter(stage => stage.cachedStorage !== undefined);
  const nodesWithStorageInfo = stagesWithCachesStorage.flatMap(stage => {
    const cachedStorage = stage.cachedStorage;
    const cacheNodes = nodes.filter(node => node.nodeName == "InMemoryTableScan" && node.stage !== undefined && node.stage.type == "onestage" && node.stage.stageId === stage.stageId);
    if (cachedStorage && cacheNodes.length > 0) {
      return cacheNodes.map((node, index) => ({
        nodeId: node.nodeId,
        storageInfo: index < cachedStorage.length ? cachedStorage[index] : undefined
      }));
    } else {
      return [];
    }
  });
  return nodesWithStorageInfo;
}

function calcCodegenDuration(metrics: EnrichedSqlMetric[]): number | undefined {
  return getMetricDuration("duration", metrics);
}

function calcExchangeMetrics(nodeName: string, metrics: EnrichedSqlMetric[]) {
  var exchangeMetrics: ExchangeMetrics | undefined = undefined;
  if (nodeName == "Exchange") {
    const writeDuration = getMetricDuration("shuffle write time", metrics) ?? 0;
    const readDuration =
      (getMetricDuration("fetch wait time", metrics) ?? 0) +
      (getMetricDuration("remote reqs duration", metrics) ?? 0) +
      (getMetricDuration("remote merged reqs duration", metrics) ?? 0);
    exchangeMetrics = {
      writeDuration: writeDuration,
      readDuration: readDuration,
      duration: writeDuration + readDuration,
    };
  }
  return exchangeMetrics;
}

function calcBroadcastExchangeDuration(
  nodeName: string,
  metrics: EnrichedSqlMetric[],
): number | undefined {
  if (nodeName == "BroadcastExchange") {
    const duration = getMetricDuration("time to broadcast", metrics) ?? 0;
    +(getMetricDuration("time to build", metrics) ?? 0) +
      (getMetricDuration("time to collect", metrics) ?? 0);
    return duration;
  }
  return undefined;
}

function updateNodeMetrics(
  node: EnrichedSqlNode,
  metrics: EnrichedSqlMetric[],
  graph: Graph,
  allNodes: EnrichedSqlNode[],
): EnrichedSqlMetric[] {

  const updatedOriginalMetrics = calcNodeMetrics(node.type, metrics);
  const filterRatio = addFilterRatioMetric(node, updatedOriginalMetrics, graph, allNodes);
  const crossJoinFilterRatio = addCrossJoinFilterRatioMetric(node, updatedOriginalMetrics, graph, allNodes);
  const joinMetrics = addJoinMetrics(node, updatedOriginalMetrics, graph, allNodes);
  return [
    ...updatedOriginalMetrics,
    ...(filterRatio !== null
      ? [filterRatio]
      : []),
    ...(crossJoinFilterRatio !== null
      ? crossJoinFilterRatio
      : []),
    ...(joinMetrics !== null
      ? joinMetrics
      : []),
  ];
}

function addFilterRatioMetric(
  node: EnrichedSqlNode,
  updatedMetrics: EnrichedSqlMetric[],
  graph: Graph,
  allNodes: EnrichedSqlNode[],
): EnrichedSqlMetric | null {
  if (node.nodeName.includes("Filter") || node.enrichedName === "Distinct") {
    let inputRows = 0;
    const inputNode = findLastNodeWithInputRows(node, graph, allNodes);

    if (inputNode) {

      const foundInputRows = getRowsFromMetrics(inputNode.metrics);
      if (foundInputRows !== null) {
        inputRows = foundInputRows;
      }
    }

    if (inputRows === 0) {
      return null;
    }

    const outputRowsMetric = updatedMetrics.find((m) => m.name.includes("rows"));
    if (!outputRowsMetric) {
      return null;
    }

    const outputRows = parseFloat(outputRowsMetric.value.replace(/,/g, ""));
    if (isNaN(outputRows)) {
      return null;
    }

    const filteredRowsPercentage = calculatePercentage(inputRows - outputRows, inputRows).toFixed(2);
    return { name: "Rows Filtered", value: filteredRowsPercentage.toString() + "%" };
  }
  return null;
}

function addCrossJoinFilterRatioMetric(
  node: EnrichedSqlNode,
  updatedMetrics: EnrichedSqlMetric[],
  graph: Graph,
  allNodes: EnrichedSqlNode[],
): EnrichedSqlMetric[] | null {
  if (node.nodeName === "BroadcastNestedLoopJoin" || node.nodeName === "CartesianProduct") {
    const inputEdges = graph.inEdges(node.nodeId.toString());
    if (!inputEdges || inputEdges.length !== 2) {
      return null;
    }
    const inputNodes = inputEdges.map(edge => allNodes.find(n => n.nodeId.toString() === edge.v));
    const inputNodesRows = inputNodes.map(node => getRowsFromMetrics(node?.metrics)).filter(row => row !== null);
    if (inputNodesRows.length !== 2) {
      return null;
    }

    const crossJoinRows = getRowsFromMetrics(updatedMetrics);
    if (crossJoinRows === null || inputNodesRows[0] === null || inputNodesRows[1] === null) {
      return null;
    }
    const crossJoinScannedRows = inputNodesRows[0] * inputNodesRows[1];
    const crossJoinFilteredRatio = (100.0 - calculatePercentage(crossJoinRows, crossJoinScannedRows)).toFixed(2);
    return [
      { name: "Cross Join Scanned Rows", value: crossJoinScannedRows.toString() },
      { name: "Rows Filtered", value: crossJoinFilteredRatio.toString() + "%" }
    ];
  }
  return null;
}

function addJoinMetrics(
  node: EnrichedSqlNode,
  updatedMetrics: EnrichedSqlMetric[],
  graph: Graph,
  allNodes: EnrichedSqlNode[],
): EnrichedSqlMetric[] | null {
  if (node.nodeName === "BroadcastHashJoin" || node.nodeName === "SortMergeJoin" || node.nodeName === "ShuffleHashJoin") {
    const inputEdges = graph.inEdges(node.nodeId.toString());
    if (!inputEdges || inputEdges.length !== 2) {
      return null;
    }
    const inputRows = inputEdges.map(edge => {
      const node = allNodes.find(n => n.nodeId.toString() === edge.v)
      if (node === undefined) {
        return null;
      }
      const nodeWithRows = findLastNodeWithInputRows(node, graph, allNodes);
      if (nodeWithRows === null) {
        return null;
      }
      const rows = getRowsFromMetrics(nodeWithRows.metrics);
      if (rows === null) {
        return null;
      }
      return rows
    }).filter(rows => rows !== null);
    if (inputRows.length !== 2) {
      return null;
    }

    const joinOutputRows = getRowsFromMetrics(updatedMetrics);
    if (joinOutputRows === null || inputRows[0] === null || inputRows[1] === null) {
      return null;
    }

    const maxInputRows = Math.max(inputRows[0], inputRows[1]);

    const joinRatio = maxInputRows !== 0 ? joinOutputRows / maxInputRows : 0

    if (joinRatio > 1) {
      const joinRatioPercentage = joinRatio.toFixed(1);
      return [
        { name: "join rows increase ratio", value: joinRatioPercentage.toString() + "X" },
      ];
    } else {
      const joinRatioPercentage = calculatePercentage(joinOutputRows, maxInputRows).toFixed(2);
      return [
        { name: "join rows filtered", value: joinRatioPercentage.toString() + "%" },
      ];
    }

  }
  return null;
}
