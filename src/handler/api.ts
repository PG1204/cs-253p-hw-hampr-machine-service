import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import {
  GetMachineRequestModel,
  HttpResponseCode,
  MachineResponseModel,
  RequestMachineRequestModel,
  RequestModel,
  StartMachineRequestModel,
} from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";

/**
 * Handles API requests for machine operations.
 * Responsible for routing requests to the appropriate handlers and managing overall workflow.
 */
export class ApiHandler {
  private cache: DataCache<MachineStateDocument>;
  private table: MachineStateTable;
  private idp: IdentityProviderClient;
  private smc: SmartMachineClient;

  constructor() {
    this.cache = DataCache.getInstance<MachineStateDocument>();
    this.table = MachineStateTable.getInstance();
    this.idp = IdentityProviderClient.getInstance();
    this.smc = SmartMachineClient.getInstance();
  }

  /**
   * Validates an authentication token.
   * Throws an Error (stringified) if the token is invalid.
   */
  private checkToken(token: string): void {
    if (!token || !this.idp.validateToken(token)) {
      throw new Error(
        JSON.stringify({
          statusCode: HttpResponseCode.UNAUTHORIZED,
          message: "Invalid token",
        })
      );
    }
  }

  /**
   * Handles a request to find and reserve an available machine at a specific location.
   */
  private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
    const machines = this.table.listMachinesAtLocation(request.locationId);
    const available = machines.find(m => m.status === MachineStatus.AVAILABLE);

    if (!available) {
      return { statusCode: HttpResponseCode.NOT_FOUND, machine: undefined };
    }

    this.table.updateMachineStatus(available.machineId, MachineStatus.AWAITING_DROPOFF);
    this.table.updateMachineJobId(available.machineId, request.jobId);

    // Now get the updated machine reference
    const updatedMachine = this.table.getMachine(available.machineId);
    if (updatedMachine) {
      this.cache.put(updatedMachine.machineId, updatedMachine);
      return { statusCode: HttpResponseCode.OK, machine: updatedMachine };
    } else {
      return { statusCode: HttpResponseCode.NOT_FOUND, machine: undefined };
    }
  }

  /**
   * Retrieves the state of a specific machine.
   */
  private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
    let machine = this.cache.get(request.machineId);
    if (!machine) {
      machine = this.table.getMachine(request.machineId);
      if (machine) this.cache.put(machine.machineId, machine);
    }
    if (!machine) {
      return { statusCode: HttpResponseCode.NOT_FOUND, machine: undefined };
    }
    return { statusCode: HttpResponseCode.OK, machine };
  }

  /**
   * Starts the cycle of a machine that is awaiting drop-off.
   */
  private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
    let machine = this.cache.get(request.machineId) || this.table.getMachine(request.machineId);
    if (!machine) {
      return { statusCode: HttpResponseCode.NOT_FOUND, machine: undefined };
    }
    if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
      return { statusCode: HttpResponseCode.BAD_REQUEST, machine };
    }
    try {
      this.smc.startCycle(machine.machineId);
      this.table.updateMachineStatus(machine.machineId, MachineStatus.RUNNING);

      const updatedMachine = this.table.getMachine(machine.machineId);
      if (updatedMachine) {
        this.cache.put(updatedMachine.machineId, updatedMachine);
        return { statusCode: HttpResponseCode.OK, machine: updatedMachine };
      } else {
        return { statusCode: HttpResponseCode.NOT_FOUND, machine: undefined };
      }
    } catch (error) {
      this.table.updateMachineStatus(machine.machineId, MachineStatus.ERROR);

      const errorMachine = this.table.getMachine(machine.machineId);
      if (errorMachine) {
        this.cache.put(errorMachine.machineId, errorMachine);
        return { statusCode: HttpResponseCode.HARDWARE_ERROR, machine: errorMachine };
      } else {
        return { statusCode: HttpResponseCode.NOT_FOUND, machine: undefined };
      }
    }
  }

  /**
   * Entry point for handling API requests.
   * Validates token and routes the request to the appropriate handler.
   * If token check throws, error propagates (for .toThrow in tests).
   */
  public handle(request: RequestModel) {
    // First, validate the token.
    this.checkToken(request.token);

    // Handle POST /machine/request
    if (request.method === 'POST' && request.path === '/machine/request') {
      return this.handleRequestMachine(request as RequestMachineRequestModel);
    }

    // Handle GET /machine/:id
    const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'GET' && getMachineMatch) {
      const machineId = getMachineMatch[1];
      const getRequest = { ...request, machineId } as GetMachineRequestModel;
      return this.handleGetMachine(getRequest);
    }

    // Handle POST /machine/:id/start
    const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
    if (request.method === 'POST' && startMachineMatch) {
      const machineId = startMachineMatch[1];
      const startRequest = { ...request, machineId } as StartMachineRequestModel;
      return this.handleStartMachine(startRequest);
    }

    // If no match, return internal server error
    return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: null };
  }
}
