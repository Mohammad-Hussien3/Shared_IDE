from rest_framework import serializers
from .models import Workspace, Folder, File
from .execution import language_from_filename


class FileTreeSerializer(serializers.ModelSerializer):
    type = serializers.SerializerMethodField()

    class Meta:
        model = File
        fields = ["id", "name", "type", "language", 'content']

    def get_type(self, obj):
        return "file"


class FolderTreeSerializer(serializers.ModelSerializer):
    type = serializers.SerializerMethodField()
    children = serializers.SerializerMethodField()

    class Meta:
        model = Folder
        fields = ["id", "name", "type", "children"]

    def get_type(self, obj):
        return "folder"

    def get_children(self, obj):
        children = []

        for file in obj.files.all():
            children.append(
                FileTreeSerializer(file).data
            )

        for folder in obj.children.all():
            children.append(
                FolderTreeSerializer(folder).data
            )

        return children


class WorkspaceTreeSerializer(serializers.ModelSerializer):
    children = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = ["id", "name", "children"]

    def get_children(self, obj):
        children = []

        for file in obj.files.filter(folder__isnull=True):
            children.append(
                FileTreeSerializer(file).data
            )

        for folder in obj.folders.filter(parent__isnull=True):
            children.append(
                FolderTreeSerializer(folder).data
            )

        return children


class FolderSerializer(serializers.ModelSerializer):
    parent = serializers.PrimaryKeyRelatedField(
        queryset=Folder.objects.all(),
        required=False,
        allow_null=True,
    )

    class Meta:
        model = Folder
        fields = ["id", "name", "parent", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_parent(self, parent):
        workspace = self.context["workspace"]
        if parent is not None and parent.workspace_id != workspace.id:
            raise serializers.ValidationError(
                "Parent folder must belong to this workspace."
            )
        return parent


class FileSerializer(serializers.ModelSerializer):
    folder = serializers.PrimaryKeyRelatedField(
        queryset=Folder.objects.all(),
        required=False,
        allow_null=True,
    )

    class Meta:
        model = File
        fields = [
            "id",
            "name",
            "language",
            "content",
            "folder",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_folder(self, folder):
        workspace = self.context["workspace"]
        if folder is not None and folder.workspace_id != workspace.id:
            raise serializers.ValidationError(
                "Folder must belong to this workspace."
            )
        return folder

    def validate(self, attrs):
        if "name" in attrs or "language" in attrs:
            name = attrs.get("name", getattr(self.instance, "name", ""))
            language = attrs.get(
                "language", getattr(self.instance, "language", "")
            )
            filename_language = language_from_filename(name)
            aliases = {"c++": "cpp", "c#": "csharp", "shell": "bash"}
            normalized_language = aliases.get(language.strip().lower(), language.strip().lower())
            if filename_language and normalized_language != filename_language:
                raise serializers.ValidationError({
                    "language": (
                        f"The {name.rsplit('.', 1)[-1]} extension requires "
                        f"language '{filename_language}'."
                    )
                })
        return attrs


class RunFileRequestSerializer(serializers.Serializer):
    content = serializers.CharField(allow_blank=True, max_length=65536)
