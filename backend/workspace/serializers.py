from rest_framework import serializers
from .models import Workspace, Folder, File


class FileSerializer(serializers.ModelSerializer):
    class Meta:
        model = File
        fields = [
            "id",
            "name",
            "content",
            "language",
            "folder",
            "created_at",
            "updated_at",
        ]


class FolderSerializer(serializers.ModelSerializer):
    class Meta:
        model = Folder
        fields = [
            "id",
            "name",
            "parent",
            "created_at",
        ]


class WorkspaceSerializer(serializers.ModelSerializer):
    files = FileSerializer(many=True, read_only=True)
    folders = FolderSerializer(many=True, read_only=True)

    class Meta:
        model = Workspace
        fields = [
            "id",
            "name",
            "created_at",
            "updated_at",
            "files",
            "folders",
        ]