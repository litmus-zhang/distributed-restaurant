import { randomUUID } from "node:crypto";

export interface QueueItem {
	id: string; // client-side operation UUID
	tenantId: string;
	clientId: string;
	sequenceNumber: number;
	timestamp: string;
	sku: string;
	quantityChange: number;
	versionNumber: number; // expected version number for optimistic concurrency control
}

export class LocalQueue {
	private queue: QueueItem[] = [];
	private sequenceNumber = 1;

	constructor(
		public readonly tenantId: string,
		public readonly clientId: string,
	) {}

	/**
	 * Enqueue an inventory modification operation.
	 * Generates a unique client ID, sequence number, and timestamp.
	 */
	public enqueue(
		sku: string,
		quantityChange: number,
		versionNumber: number,
	): QueueItem {
		const item: QueueItem = {
			id: randomUUID(),
			tenantId: this.tenantId,
			clientId: this.clientId,
			sequenceNumber: this.sequenceNumber++,
			timestamp: new Date().toISOString(),
			sku,
			quantityChange,
			versionNumber,
		};
		this.queue.push(item);
		return item;
	}

	/**
	 * Get all queued operations.
	 */
	public getBatch(): QueueItem[] {
		return [...this.queue];
	}

	/**
	 * Remove successfully synced operations from the queue.
	 */
	public clearProcessed(syncedIds: string[]): void {
		const idsSet = new Set(syncedIds);
		this.queue = this.queue.filter((item) => !idsSet.has(item.id));
	}

	/**
	 * Clear the queue entirely.
	 */
	public clear(): void {
		this.queue = [];
		this.sequenceNumber = 1;
	}

	/**
	 * Get the size of the queue.
	 */
	public size(): number {
		return this.queue.length;
	}
}
