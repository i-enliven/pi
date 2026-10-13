import type { AnyModel, Api, Model, ModelType, ModelTypeMap } from "../types.ts";
import { ModelsError } from "./models-error.ts";

/** The type of a model. Models without `type` are chat models. */
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}

/** Runtime-checked model type narrowing, including legacy chat models without `type`. */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (getModelType(model) !== "chat") {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}
